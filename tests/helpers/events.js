"use strict";

const crypto = require("crypto");

/** Build an API Gateway (REST, proxy) event like serverless-offline / API Gateway would send. */
function apiEvent({ method = "GET", pathParameters, body, headers = {}, query, sourceIp = "127.0.0.1" } = {}) {
  return {
    httpMethod: method,
    pathParameters: pathParameters || null,
    queryStringParameters: query || null,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { requestId: crypto.randomUUID(), identity: { sourceIp } },
  };
}

/** Invoke a handler and parse its JSON body. */
async function invoke(handler, event) {
  const res = await handler(event);
  return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
}

const uniqueKey = (prefix = "key") => `${prefix}-${crypto.randomUUID()}`;

module.exports = { apiEvent, invoke, uniqueKey };
