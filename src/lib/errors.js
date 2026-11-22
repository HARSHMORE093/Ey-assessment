"use strict";

/**
 * Domain error type. Services throw these; the handler wrapper (src/middleware/withHandler.js)
 * is the ONLY place that turns them into HTTP responses.
 *
 * `error` is the machine-readable code placed in the contract's `{ error, message }` body.
 * `headers` lets an error carry e.g. Retry-After.
 */
class AppError extends Error {
  constructor(statusCode, error, message, headers) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.error = error;
    this.headers = headers;
  }
}

const badRequest = (message, code = "BAD_REQUEST") => new AppError(400, code, message);
const unauthorized = (message = "Authentication required") =>
  new AppError(401, "UNAUTHORIZED", message, { "WWW-Authenticate": "Bearer" });
const forbidden = (message = "You are not allowed to perform this action") =>
  new AppError(403, "FORBIDDEN", message);
const notFound = (message, code = "NOT_FOUND") => new AppError(404, code, message);
const conflict = (message, code = "CONFLICT", headers) => new AppError(409, code, message, headers);
const unprocessable = (message, code = "UNPROCESSABLE_ENTITY") => new AppError(422, code, message);
const tooManyRequests = (retryAfterSeconds) =>
  new AppError(429, "RATE_LIMITED", "Too many requests, please retry later", {
    "Retry-After": String(retryAfterSeconds),
  });
const serviceUnavailable = (message = "Service temporarily busy, please retry", retryAfterSeconds = 1) =>
  new AppError(503, "SERVICE_UNAVAILABLE", message, { "Retry-After": String(retryAfterSeconds) });

/**
 * Internal (non-HTTP) signals raised by the repository layer and interpreted by services.
 */

/** The optimistic-lock condition (version check) failed or DynamoDB reported a TransactionConflict. Safe to retry. */
class ConcurrencyConflictError extends Error {
  constructor(message = "Concurrent modification detected") {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

/** A record with the same idempotency key was committed by a concurrent request. Replay it. */
class IdempotencyCollisionError extends Error {
  constructor() {
    super("Idempotency key already used");
    this.name = "IdempotencyCollisionError";
  }
}

module.exports = {
  AppError,
  ConcurrencyConflictError,
  IdempotencyCollisionError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  serviceUnavailable,
};
