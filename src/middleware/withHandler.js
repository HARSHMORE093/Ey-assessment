"use strict";

const crypto = require("crypto");
const { AppError, badRequest } = require("../lib/errors");
const { error: errorResponse } = require("../lib/response");
const { logger } = require("../lib/logger");
const { authenticate } = require("./auth");
const rateLimiter = require("./rateLimiter");

/**
 * Wraps every Lambda handler with the cross-cutting concerns an Express app would get
 * from middleware:
 *
 *   1. correlation / request id (echoed as X-Request-Id and inside error bodies)
 *   2. structured, PII-safe logging with that id on every line
 *   3. authentication → principal
 *   4. per-client rate limiting (back-pressure)
 *   5. centralised error → HTTP mapping. Stack traces and DB details are never
 *      returned to the client, only logged.
 *
 * Handlers receive a small context object and just return a response.
 */

const MAX_BODY_BYTES = 16 * 1024;
const THROTTLE_ERRORS = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "TooManyRequestsException",
]);

function lowerCaseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}

function resolveRequestId(event, headers) {
  // Accept a caller-supplied correlation id only if it looks sane (avoid log injection).
  const supplied = headers["x-request-id"];
  if (supplied && /^[A-Za-z0-9-]{8,64}$/.test(supplied)) return supplied;
  return event.requestContext?.requestId && event.requestContext.requestId !== "offline_requestId"
    ? event.requestContext.requestId
    : crypto.randomUUID();
}

function parseBody(event) {
  if (!event.body) throw badRequest("Request body is required");
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw badRequest("Request body too large");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw badRequest("Request body must be a JSON object");
  }
  return data;
}

/** Map any thrown value to a safe HTTP error response. */
function toErrorResponse(err, requestId, log) {
  if (err instanceof AppError) {
    const level = err.statusCode >= 500 ? "error" : "info";
    log[level]("Request rejected", { statusCode: err.statusCode, code: err.error });
    return errorResponse(err.statusCode, err.error, err.message, requestId, err.headers);
  }
  if (THROTTLE_ERRORS.has(err?.name)) {
    // DynamoDB pushed back even after SDK retries. Shed load with a retryable 503.
    log.warn("Downstream throttling", { errorName: err.name });
    return errorResponse(503, "SERVICE_UNAVAILABLE", "Service temporarily busy, please retry", requestId, {
      "Retry-After": "1",
    });
  }
  // Unknown failure: log everything server-side, return nothing sensitive.
  log.error("Unhandled error", { errorName: err?.name, errorMessage: err?.message, stack: err?.stack });
  return errorResponse(500, "INTERNAL_SERVER_ERROR", "Unexpected server error", requestId);
}

function withHandler(fn, { rateLimit = true } = {}) {
  return async (event = {}) => {
    const started = Date.now();
    const headers = lowerCaseHeaders(event.headers);
    const requestId = resolveRequestId(event, headers);
    const log = logger.child({ requestId, method: event.httpMethod, path: event.resource || event.path });

    let response;
    try {
      const principal = await authenticate(event, headers);
      if (rateLimit) rateLimiter.take(rateLimiter.clientKeyFor(event, principal));

      response = await fn({
        event,
        headers,
        principal,
        requestId,
        log: log.child({ principal: principal.sub }),
        body: () => parseBody(event),
        pathParam: (name) => event.pathParameters?.[name],
        query: () => event.queryStringParameters || {},
      });
    } catch (err) {
      response = toErrorResponse(err, requestId, log);
    }

    response.headers = { ...response.headers, "X-Request-Id": requestId };
    log.info("Request completed", { statusCode: response.statusCode, durationMs: Date.now() - started });
    return response;
  };
}

module.exports = { withHandler, toErrorResponse, lowerCaseHeaders };
