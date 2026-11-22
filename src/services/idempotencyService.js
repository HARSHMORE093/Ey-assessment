"use strict";

const idempotencyRepository = require("../repositories/idempotencyRepository");
const { getConfig } = require("../config");
const { clock } = require("../lib/clock");
const { sha256, canonicalJson } = require("../lib/hash");
const { badRequest, unprocessable, conflict, IdempotencyCollisionError } = require("../lib/errors");
const { idempotencyKey: keySchema } = require("../validators/schemas");

/**
 * IDEMPOTENCY for POST requests (Idempotency-Key header, as Stripe and the IETF draft do it).
 *
 * Problem: a client sends "withdraw 100", the network drops the response, the client retries.
 * Without idempotency the customer is debited twice.
 *
 * Flow:
 *   1. No key → run normally (or 400 if REQUIRE_IDEMPOTENCY_KEY=true for money endpoints).
 *   2. Key seen before:
 *        same payload      → return the ORIGINAL response (no second debit), header Idempotent-Replayed: true
 *        different payload → 422 IDEMPOTENCY_KEY_REUSED (client bug; never guess)
 *   3. Key unseen → run the operation. The operation commits the idempotency record INSIDE the
 *      same DynamoDB transaction as the money movement (atomic: both or neither).
 *   4. Two identical requests racing: both pass step 2, but only one transaction can satisfy
 *      `attribute_not_exists(idempotencyKey)`. The loser gets IdempotencyCollisionError,
 *      re-reads the winner's record and replays it. Exactly-once effect, even under concurrency.
 *
 * Only successful outcomes are stored. A rejected request (e.g. insufficient funds) changed
 * nothing, so re-evaluating it on retry is safe and lets the client succeed after topping up.
 *
 * Keys are scoped to the caller (principal.sub), so two customers can never collide or read
 * each other's stored responses. The raw key is hashed before storage.
 */

const NO_IDEMPOTENCY = Object.freeze({ key: null, buildItem: () => null });

function replay(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw unprocessable(
      "Idempotency-Key was already used with a different request payload",
      "IDEMPOTENCY_KEY_REUSED"
    );
  }
  return {
    statusCode: record.statusCode,
    body: JSON.parse(record.responseBody),
    headers: {
      "Idempotent-Replayed": "true",
      ...(record.transactionId ? { "X-Transaction-Id": record.transactionId } : {}),
    },
  };
}

/**
 * @param {object}   p
 * @param {string}   p.rawKey     value of the Idempotency-Key header (may be undefined)
 * @param {object}   p.principal  caller (scopes the key)
 * @param {object}   p.payload    operation name + path params + validated body (fingerprinted)
 * @param {boolean}  p.enforce    true for money-moving endpoints (honours REQUIRE_IDEMPOTENCY_KEY)
 * @param {Function} operation    async (idem) => ({ statusCode, body, headers }).
 *                                Must include idem.buildItem(result, transactionId) in its transaction.
 */
async function execute({ rawKey, principal, payload, enforce = false, log }, operation) {
  const { required, ttlSeconds } = getConfig().idempotency;

  if (rawKey === undefined || rawKey === null || rawKey === "") {
    if (enforce && required) throw badRequest("Idempotency-Key header is required", "IDEMPOTENCY_KEY_REQUIRED");
    return operation(NO_IDEMPOTENCY);
  }
  if (keySchema.validate(rawKey).error) {
    throw badRequest("Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.]", "INVALID_IDEMPOTENCY_KEY");
  }

  const key = sha256(`${principal.sub}|${rawKey}`);
  const requestHash = sha256(canonicalJson(payload));
  const nowSec = () => Math.floor(clock.now().getTime() / 1000);

  // Fast path: a retry of a request that has already completed.
  const existing = await idempotencyRepository.get(key);
  if (existing && existing.expiresAt >= nowSec()) {
    log?.info("Idempotent replay", { phase: "pre-check" });
    return replay(existing, requestHash);
  }

  const idem = {
    key,
    buildItem(result, transactionId) {
      const now = nowSec();
      return idempotencyRepository.buildPut(
        {
          idempotencyKey: key,
          requestHash,
          statusCode: result.statusCode,
          responseBody: JSON.stringify(result.body),
          transactionId,
          createdAt: new Date(now * 1000).toISOString(),
          expiresAt: now + ttlSeconds,
        },
        now
      );
    },
  };

  try {
    return await operation(idem);
  } catch (err) {
    if (!(err instanceof IdempotencyCollisionError)) throw err;
    // Lost the race to an identical concurrent request: replay its committed result.
    const winner = await idempotencyRepository.get(key);
    if (!winner) throw conflict("Request is being processed, please retry", "IDEMPOTENCY_IN_PROGRESS", { "Retry-After": "1" });
    log?.info("Idempotent replay", { phase: "commit-race" });
    return replay(winner, requestHash);
  }
}

module.exports = { execute };
