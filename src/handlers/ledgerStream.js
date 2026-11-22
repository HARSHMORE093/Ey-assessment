"use strict";

const { SQSClient, SendMessageBatchCommand } = require("@aws-sdk/client-sqs");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { logger } = require("../lib/logger");

/**
 * DynamoDB Streams consumer: the TRANSACTIONAL OUTBOX relay.
 *
 * DUAL-WRITE problem: "update the DB, then publish an event to SQS/SNS" in the API handler is
 * not atomic. If the process dies between the two writes, the DB says money moved but
 * downstream systems (notifications, fraud, reporting) never hear about it, or the reverse.
 *
 * Solution: the API writes ONLY to DynamoDB (balance + ledger entry, atomically). The ledger
 * entry IS the event. DynamoDB Streams captures every committed INSERT, and this Lambda
 * forwards it to an SQS queue. Delivery is at-least-once, so downstream state is
 * EVENTUALLY CONSISTENT with the ledger.
 *
 *  - Streams can redeliver, so the SQS message carries a deterministic id (eventId) and
 *    consumers de-duplicate on it (idempotent consumers).
 *  - Partial batch failure: we return `batchItemFailures` so only the failed records are
 *    retried, not the whole batch. After the configured retries, failed records go to an
 *    on-failure destination (DLQ), so one poison record cannot block the shard. Configured in infra/.
 *  - Ordering: stream records are ordered per partition key; we preserve batch order.
 */

const sqs = new SQSClient({}); // created once per container (connection reuse)
const SQS_BATCH_LIMIT = 10;

function toEvent(record) {
  const entry = unmarshall(record.dynamodb.NewImage);
  return {
    eventId: `${entry.transactionId}:${entry.accountId}`, // deterministic → consumer de-duplication key
    eventType: `ledger.${entry.type.toLowerCase()}.${entry.direction.toLowerCase()}`,
    transactionId: entry.transactionId,
    accountId: entry.accountId,
    amount: entry.amount,
    currency: entry.currency,
    balanceAfter: entry.balanceAfter,
    occurredAt: entry.createdAt,
  };
}

async function handler(event) {
  const queueUrl = process.env.EVENTS_QUEUE_URL;
  const inserts = (event.Records || []).filter((r) => r.eventName === "INSERT" && r.dynamodb?.NewImage);
  const batchItemFailures = [];

  for (let i = 0; i < inserts.length; i += SQS_BATCH_LIMIT) {
    const chunk = inserts.slice(i, i + SQS_BATCH_LIMIT);
    try {
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((record, idx) => ({
            Id: String(idx),
            MessageBody: JSON.stringify(toEvent(record)),
          })),
        })
      );
      for (const failed of res.Failed || []) {
        batchItemFailures.push({ itemIdentifier: chunk[Number(failed.Id)].dynamodb.SequenceNumber });
      }
    } catch (err) {
      logger.error("Failed to publish ledger events", { errorName: err.name, count: chunk.length });
      chunk.forEach((r) => batchItemFailures.push({ itemIdentifier: r.dynamodb.SequenceNumber }));
    }
  }

  logger.info("Ledger events relayed", { received: inserts.length, failed: batchItemFailures.length });
  // Streams resume from the LOWEST failed sequence number, preserving per-key ordering.
  return { batchItemFailures };
}

module.exports = { handler, toEvent };
