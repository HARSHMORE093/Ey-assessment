"use strict";

const { getConfig } = require("../config");
const { tooManyRequests } = require("../lib/errors");

/**
 * Token-bucket rate limiter (one bucket per client key), held in memory per Lambda container.
 *
 * Back-pressure layers in this system, from the outside in:
 *   1. AWS WAF rate-based rule: per source IP, distributed, at the edge          (infra/)
 *   2. API Gateway stage + method throttling: account-wide, distributed         (infra/)
 *   3. Lambda reserved concurrency: hard cap on parallel executions             (infra/)
 *   4. THIS limiter: per container, sheds a noisy client before it touches DynamoDB
 *   5. DynamoDB SDK adaptive retry: client-side slowdown when the table throttles (src/lib/dynamodb.js)
 *
 * Layer 4 alone is NOT a global limit (each container has its own buckets), which is why the
 * distributed layers 1-2 exist. It is cheap, though, and stops one client from starving
 * others that share the same warm container.
 *
 * Algorithm: each bucket holds up to `capacity` tokens and refills at `refillPerSecond`.
 * A request costs 1 token. Time O(1), space O(number of active clients), bounded by MAX_BUCKETS.
 */

const MAX_BUCKETS = 10000;
const buckets = new Map();

function take(clientKey, nowMs = Date.now()) {
  const { enabled, capacity, refillPerSecond } = getConfig().rateLimit;
  if (!enabled) return;

  let bucket = buckets.get(clientKey);
  if (!bucket) {
    // Bounded memory: drop the oldest-inserted bucket when full (Map keeps insertion order).
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
    bucket = { tokens: capacity, updatedAt: nowMs };
    buckets.set(clientKey, bucket);
  }

  // Refill proportionally to elapsed time, never above capacity.
  const elapsedSec = (nowMs - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond);
  bucket.updatedAt = nowMs;

  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
    throw tooManyRequests(retryAfter);
  }
  bucket.tokens -= 1;
}

/** Identify the caller: authenticated subject first, then source IP. */
function clientKeyFor(event, principal) {
  return (
    principal?.sub ||
    event.requestContext?.identity?.sourceIp ||
    event.headers?.["x-forwarded-for"]?.split(",")[0].trim() ||
    "anonymous"
  );
}

function resetRateLimiter() {
  buckets.clear();
}

module.exports = { take, clientKeyFor, resetRateLimiter };
