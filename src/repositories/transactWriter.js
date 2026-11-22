"use strict";

const { TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../lib/dynamodb");
const { ConcurrencyConflictError, IdempotencyCollisionError } = require("../lib/errors");

/**
 * The single place where multi-item writes happen.
 *
 * ATOMICITY: TransactWriteItems is all-or-nothing across items AND tables. Every money
 * movement writes the account balance(s), the ledger entry(ies) and the idempotency record
 * in ONE transaction, so none of these states can ever exist:
 *   - balance changed but no ledger entry (unauditable money)
 *   - ledger entry but no balance change
 *   - transfer debited A but not credited B (partial failure)
 *   - money moved but the idempotency record is missing (a retry would double-spend)
 * This is also how we avoid DUAL WRITES: there is never a "write DB, then write somewhere
 * else" sequence in the request path. Events for other systems are derived later from the
 * ledger via DynamoDB Streams (transactional-outbox pattern, see src/handlers/ledgerStream.js).
 *
 * ClientRequestToken makes the call itself idempotent for 10 minutes. If the SDK retries
 * after a network timeout where the first attempt actually committed, DynamoDB returns
 * success instead of applying the write twice. Without the token, that retry would fail its
 * version condition, look like a concurrency conflict, and our retry loop would debit again.
 *
 * DEADLOCKS: DynamoDB transactions use optimistic concurrency. A conflicting transaction is
 * cancelled (TransactionConflict) instead of waiting for a lock, so no lock is ever held while
 * waiting for another: deadlock cannot happen. Callers still build items in a canonical
 * (sorted by key) order, the classic lock-ordering rule, so behaviour stays deterministic if
 * this were ever ported to a lock-based store.
 */
async function commit({ items, idempotencyItem, clientRequestToken }) {
  const transactItems = idempotencyItem ? [...items, idempotencyItem] : items;
  const idempotencyIndex = idempotencyItem ? transactItems.length - 1 : -1;

  try {
    await docClient.send(
      new TransactWriteCommand({ TransactItems: transactItems, ClientRequestToken: clientRequestToken })
    );
  } catch (err) {
    if (err.name !== "TransactionCanceledException") throw err;
    const reasons = err.CancellationReasons || [];

    // A concurrent request with the same Idempotency-Key committed first: the caller replays its result.
    if (idempotencyIndex >= 0 && reasons[idempotencyIndex]?.Code === "ConditionalCheckFailed") {
      throw new IdempotencyCollisionError();
    }
    // Version check failed (someone updated the account after we read it) or DynamoDB detected
    // a conflicting in-flight transaction on the same item. Both are safe to retry from a fresh read.
    if (reasons.some((r) => r?.Code === "ConditionalCheckFailed" || r?.Code === "TransactionConflict")) {
      throw new ConcurrencyConflictError();
    }
    throw err; // e.g. ThrottlingError / ValidationError → mapped centrally
  }
}

module.exports = { commit };
