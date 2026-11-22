"use strict";

const { mockClient } = require("aws-sdk-client-mock");
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const transactions = require("../../src/handlers/transactions");
const transactWriter = require("../../src/repositories/transactWriter");
const { ConcurrencyConflictError, IdempotencyCollisionError } = require("../../src/lib/errors");
const { apiEvent, invoke } = require("../helpers/events");

/**
 * DynamoDB failure modes that are hard or impossible to trigger on DynamoDB Local on demand
 * (TransactionConflict, throttling) are simulated with aws-sdk-client-mock.
 * Real-AWS behaviour should additionally be verified in a staging account (see README).
 */
const ddb = mockClient(DynamoDBDocumentClient);

const account = { accountId: "acct_m1", customerId: "cust_m", type: "CHECKING", currency: "CAD", balance: 100, status: "OPEN", createdAt: "2026-01-01T00:00:00.000Z", version: 3 };

const cancelled = (...codes) => {
  const e = new Error("Transaction cancelled");
  e.name = "TransactionCanceledException";
  e.CancellationReasons = codes.map((Code) => ({ Code }));
  return e;
};

const withdrawEvent = () =>
  apiEvent({ method: "POST", pathParameters: { accountId: "acct_m1" }, body: { amount: 10, currency: "CAD" } });

beforeEach(() => ddb.reset());

describe("transactWriter: cancellation reason mapping", () => {
  test("idempotency item condition failed → IdempotencyCollisionError", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled("None", "None", "ConditionalCheckFailed"));
    await expect(transactWriter.commit({ items: [{}, {}], idempotencyItem: {} })).rejects.toBeInstanceOf(IdempotencyCollisionError);
  });

  test("version check failed → ConcurrencyConflictError", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled("ConditionalCheckFailed", "None"));
    await expect(transactWriter.commit({ items: [{}, {}] })).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  test("TransactionConflict (concurrent transaction on same item) → ConcurrencyConflictError", async () => {
    ddb.on(TransactWriteCommand).rejects(cancelled("TransactionConflict", "None"));
    await expect(transactWriter.commit({ items: [{}, {}] })).rejects.toBeInstanceOf(ConcurrencyConflictError);
  });

  test("ClientRequestToken is always sent (safe SDK retries after ambiguous timeouts)", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await transactWriter.commit({ items: [{}], clientRequestToken: "tok-123" });
    expect(ddb.commandCalls(TransactWriteCommand)[0].args[0].input.ClientRequestToken).toBe("tok-123");
  });
});

describe("withdrawal under DynamoDB failures", () => {
  test("TransactionConflict twice, then success → 200, three commit attempts, fresh read each time", async () => {
    ddb.on(GetCommand).resolves({ Item: account });
    ddb
      .on(TransactWriteCommand)
      .rejectsOnce(cancelled("TransactionConflict", "None"))
      .rejectsOnce(cancelled("ConditionalCheckFailed", "None"))
      .resolves({});

    const res = await invoke(transactions.withdraw, withdrawEvent());
    expect(res.statusCode).toBe(200);
    expect(res.json.balance).toBe(90);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(3);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(3);

    // each optimistic attempt uses a distinct ClientRequestToken
    const tokens = ddb.commandCalls(TransactWriteCommand).map((c) => c.args[0].input.ClientRequestToken);
    expect(new Set(tokens).size).toBe(3);
  });

  test("the commit is conditional on the version that was read (optimistic lock)", async () => {
    ddb.on(GetCommand).resolves({ Item: account });
    ddb.on(TransactWriteCommand).resolves({});
    await invoke(transactions.withdraw, withdrawEvent());
    const [update, ledger] = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems;
    expect(update.Update.ConditionExpression).toContain("#version = :expected");
    expect(update.Update.ExpressionAttributeValues).toMatchObject({ ":expected": 3, ":next": 4, ":balance": 90 });
    expect(ledger.Put.Item).toMatchObject({ type: "WITHDRAWAL", direction: "DEBIT", amount: 10, balanceAfter: 90 });
  });

  test("persistent conflicts → bounded retries → 409 CONCURRENT_UPDATE (no infinite loop / starvation)", async () => {
    ddb.on(GetCommand).resolves({ Item: account });
    ddb.on(TransactWriteCommand).rejects(cancelled("TransactionConflict", "None"));
    const res = await invoke(transactions.withdraw, withdrawEvent());
    expect(res.statusCode).toBe(409);
    expect(res.json.error).toBe("CONCURRENT_UPDATE");
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(Number(process.env.OCC_MAX_ATTEMPTS));
  });

  test("DynamoDB throttling → 503 + Retry-After, no money moved", async () => {
    ddb.on(GetCommand).resolves({ Item: account });
    const throttled = new Error("Throughput exceeds the current capacity");
    throttled.name = "ThrottlingException";
    ddb.on(TransactWriteCommand).rejects(throttled);
    const res = await invoke(transactions.withdraw, withdrawEvent());
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("1");
  });

  test("unexpected DynamoDB error → 500 with no internals leaked", async () => {
    ddb.on(GetCommand).rejects(Object.assign(new Error("Requested resource not found: Table: Accounts"), { name: "ResourceNotFoundException" }));
    const res = await invoke(transactions.withdraw, withdrawEvent());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/Table/);
  });
});
