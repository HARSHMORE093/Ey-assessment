"use strict";

const { mockClient } = require("aws-sdk-client-mock");
const { SQSClient, SendMessageBatchCommand } = require("@aws-sdk/client-sqs");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { handler } = require("../../src/handlers/ledgerStream");

const sqs = mockClient(SQSClient);

const record = (seq, eventName = "INSERT", overrides = {}) => ({
  eventName,
  dynamodb: {
    SequenceNumber: String(seq),
    NewImage: marshall({
      transactionId: `txn_${seq}`,
      accountId: "acct_001",
      type: "WITHDRAWAL",
      direction: "DEBIT",
      amount: 10,
      currency: "CAD",
      balanceAfter: 90,
      createdAt: "2026-11-12T15:00:00.000Z",
      ...overrides,
    }),
  },
});

beforeEach(() => {
  sqs.reset();
  process.env.EVENTS_QUEUE_URL = "https://sqs.local/queue";
});

describe("ledger stream → SQS outbox relay", () => {
  test("publishes INSERTs only, with deterministic event ids for consumer de-duplication", async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    const res = await handler({ Records: [record(1), record(2, "MODIFY"), record(3)] });
    expect(res).toEqual({ batchItemFailures: [] });
    const entries = sqs.commandCalls(SendMessageBatchCommand)[0].args[0].input.Entries;
    expect(entries).toHaveLength(2);
    expect(JSON.parse(entries[0].MessageBody)).toMatchObject({
      eventId: "txn_1:acct_001",
      eventType: "ledger.withdrawal.debit",
    });
  });

  test("batches in chunks of 10 (SQS limit)", async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Failed: [] });
    await handler({ Records: Array.from({ length: 23 }, (_, i) => record(i + 1)) });
    expect(sqs.commandCalls(SendMessageBatchCommand).map((c) => c.args[0].input.Entries.length)).toEqual([10, 10, 3]);
  });

  test("partial failure → only the failed records are reported for retry", async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Failed: [{ Id: "1", Code: "InternalError" }] });
    const res = await handler({ Records: [record(1), record(2), record(3)] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "2" }]);
  });

  test("SQS outage → whole chunk reported failed (stream retries, then on-failure DLQ)", async () => {
    sqs.on(SendMessageBatchCommand).rejects(new Error("Service Unavailable"));
    const res = await handler({ Records: [record(1), record(2)] });
    expect(res.batchItemFailures).toHaveLength(2);
  });
});
