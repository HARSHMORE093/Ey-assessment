"use strict";

const { ConcurrencyConflictError, conflict } = require("./errors");

/**
 * Exponential backoff with FULL jitter (AWS Architecture Blog, "Exponential Backoff And Jitter").
 *
 *   delay = random(0, min(cap, base * 2^attempt))
 *
 * Why jitter: if 10 requests collide on the same account and all retry after exactly 20ms,
 * they collide again (a "thundering herd" / livelock). Randomising spreads them out so most
 * succeed on the next attempt.
 *
 * Why a bounded number of attempts (anti-starvation): an unlucky request on a very hot account
 * could keep losing the optimistic-lock race forever. After `maxAttempts` we stop and return a
 * retryable 409 + Retry-After, so the Lambda never burns its whole timeout. The client retries
 * later with the SAME Idempotency-Key, which keeps the retry safe.
 */
function backoffDelay(attempt, baseMs, capMs, random = Math.random) {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation(attempt)` and retry ONLY on ConcurrencyConflictError (optimistic-lock lost or
 * DynamoDB TransactionConflict). Business errors (insufficient funds, …) are thrown at once,
 * because retrying would not change the outcome.
 *
 * Time: O(maxAttempts) calls. Space: O(1).
 */
async function withOptimisticRetry(operation, { maxAttempts, baseDelayMs, maxDelayMs, log }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      if (!(err instanceof ConcurrencyConflictError)) throw err;
      if (attempt === maxAttempts - 1) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      log?.debug("Optimistic lock conflict, retrying", { attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
    }
  }
  log?.warn("Optimistic lock retries exhausted", { maxAttempts });
  throw conflict(
    "The account is being updated by another request. Please retry with the same Idempotency-Key.",
    "CONCURRENT_UPDATE",
    { "Retry-After": "1" }
  );
}

module.exports = { withOptimisticRetry, backoffDelay, sleep };
