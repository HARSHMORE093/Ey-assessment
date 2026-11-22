"use strict";

const { getConfig } = require("../config");

/**
 * API Gateway proxy-style responses.
 *
 * Body shapes follow openapi/openapi.yaml exactly:
 *   success → the resource itself (e.g. Customer / Account)
 *   error   → { error, message } (+ requestId, which the schema permits as an extra property)
 *
 * The security headers below are what `helmet` would set for an Express app. Here they are
 * applied by hand because the handlers are Lambda functions, not Express.
 */
function securityHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": getConfig().corsOrigin,
    "Access-Control-Expose-Headers": "X-Request-Id, X-Transaction-Id, Idempotent-Replayed, Retry-After",
    "Cache-Control": "no-store", // never cache balances / PII in browsers or proxies
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...securityHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

const ok = (body, headers) => json(200, body, headers);
const created = (body, headers) => json(201, body, headers);

function error(statusCode, code, message, requestId, headers) {
  return json(statusCode, { error: code, message, requestId }, headers);
}

/** Template helpers kept for compatibility. */
const badRequest = (message, code = "BAD_REQUEST") => error(400, code, message);
const notFound = (message, code = "NOT_FOUND") => error(404, code, message);
const conflict = (message, code = "CONFLICT") => error(409, code, message);
const serverError = (message = "Unexpected server error") => error(500, "INTERNAL_SERVER_ERROR", message);

/**
 * Parse a JSON body from an API Gateway / serverless-offline event.
 * Returns { ok: true, data } or { ok: false, response } with a 400 response.
 */
function parseJsonBody(event) {
  if (!event.body) {
    return { ok: false, response: badRequest("Request body is required") };
  }
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    return { ok: false, response: badRequest("Request body must be valid JSON") };
  }
}

module.exports = {
  json,
  ok,
  created,
  error,
  badRequest,
  notFound,
  conflict,
  serverError,
  parseJsonBody,
  securityHeaders,
};
