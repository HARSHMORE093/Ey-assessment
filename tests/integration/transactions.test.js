"use strict";

const tx = require("../../src/handlers/transactions");
const accounts = require("../../src/handlers/accounts");
const { clock } = require("../../src/lib/clock");
const { resetConfig } = require("../../src/config");
const { apiEvent, invoke, uniqueKey } = require("../helpers/events");
const { newAccount, setStatus, ledgerFor } = require("../helpers/fixtures");

const deposit = (accountId, body, headers) => invoke(tx.deposit, apiEvent({ method: "POST", pathParameters: { accountId }, body, headers }));
const withdraw = (accountId, body, headers) => invoke(tx.withdraw, apiEvent({ method: "POST", pathParameters: { accountId }, body, headers }));
const transfer = (body, headers) => invoke(tx.transfer, apiEvent({ method: "POST", body, headers }));
const balanceOf = async (accountId) => (await invoke(accounts.get, apiEvent({ pathParameters: { accountId } }))).json.balance;

afterEach(() => {
  jest.restoreAllMocks();
  resetConfig();
});

describe("Deposits & withdrawals", () => {
  test("deposit → 200 Account with increased balance + X-Transaction-Id; exact decimal arithmetic", async () => {
    const a = await newAccount({ balance: 0.1 });
    const res = await deposit(a.accountId, { amount: 0.2, currency: "CAD" });
    expect(res.statusCode).toBe(200);
    expect(res.json.balance).toBe(0.3); // not 0.30000000000000004
    expect(res.headers["X-Transaction-Id"]).toMatch(/^txn_/);
  });

  test("withdraw → 200; insufficient funds → 409 and balance unchanged", async () => {
    const a = await newAccount({ balance: 100 });
    expect((await withdraw(a.accountId, { amount: 40, currency: "CAD" })).json.balance).toBe(60);
    const res = await withdraw(a.accountId, { amount: 999999, currency: "CAD" });
    expect(res.statusCode).toBe(409);
    expect(res.json.error).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(a.accountId)).toBe(60);
  });

  test("withdrawing the exact balance leaves 0", async () => {
    const a = await newAccount({ balance: 25.5 });
    expect((await withdraw(a.accountId, { amount: 25.5, currency: "CAD" })).json.balance).toBe(0);
  });

  test("currency mismatch → 400; bad amount → 400; unknown account → 404", async () => {
    const a = await newAccount({ balance: 10 });
    expect((await deposit(a.accountId, { amount: 1, currency: "USD" })).json.error).toBe("CURRENCY_MISMATCH");
    expect((await deposit(a.accountId, { amount: -1, currency: "CAD" })).statusCode).toBe(400);
    expect((await deposit(a.accountId, { amount: 0, currency: "CAD" })).statusCode).toBe(400);
    expect((await deposit("acct_missing", { amount: 1, currency: "CAD" })).statusCode).toBe(404);
  });

  test("inactive (CLOSED) account: withdrawal and deposit rejected with 409", async () => {
    const a = await newAccount({ balance: 50 });
    await setStatus("account", a.accountId, "CLOSED");
    for (const op of [withdraw, deposit]) {
      const res = await op(a.accountId, { amount: 1, currency: "CAD" });
      expect(res.statusCode).toBe(409);
      expect(res.json.error).toBe("ACCOUNT_INACTIVE");
    }
  });

  test("daily withdrawal limit: allowed up to the limit, then 409, resets next business day", async () => {
    process.env.DAILY_WITHDRAWAL_LIMIT_MINOR = "10000"; // 100.00
    resetConfig();
    const now = jest.spyOn(clock, "now").mockReturnValue(new Date("2026-11-12T15:00:00Z")); // 10:00 Toronto
    const a = await newAccount({ balance: 1000 });

    expect((await withdraw(a.accountId, { amount: 60, currency: "CAD" })).statusCode).toBe(200);
    expect((await withdraw(a.accountId, { amount: 40, currency: "CAD" })).statusCode).toBe(200);
    const over = await withdraw(a.accountId, { amount: 0.01, currency: "CAD" });
    expect(over.statusCode).toBe(409);
    expect(over.json.error).toBe("DAILY_LIMIT_EXCEEDED");

    now.mockReturnValue(new Date("2026-11-13T15:00:00Z")); // next day
    expect((await withdraw(a.accountId, { amount: 100, currency: "CAD" })).statusCode).toBe(200);
    delete process.env.DAILY_WITHDRAWAL_LIMIT_MINOR;
  });

  test("deposits do not count against the withdrawal limit", async () => {
    process.env.DAILY_WITHDRAWAL_LIMIT_MINOR = "1000";
    resetConfig();
    const a = await newAccount({ balance: 0 });
    expect((await deposit(a.accountId, { amount: 500, currency: "CAD" })).statusCode).toBe(200);
    expect((await withdraw(a.accountId, { amount: 10, currency: "CAD" })).statusCode).toBe(200);
    delete process.env.DAILY_WITHDRAWAL_LIMIT_MINOR;
  });

  test("withdrawal outside banking hours (10:00-17:00 Toronto) → 409; deposits still allowed", async () => {
    process.env.WITHDRAWAL_WINDOW_START = "10:00";
    process.env.WITHDRAWAL_WINDOW_END = "17:00";
    resetConfig();
    const a = await newAccount({ balance: 100 });

    jest.spyOn(clock, "now").mockReturnValue(new Date("2026-11-12T23:30:00Z")); // 18:30 Toronto
    const late = await withdraw(a.accountId, { amount: 1, currency: "CAD" });
    expect(late.statusCode).toBe(409);
    expect(late.json.error).toBe("OUTSIDE_WITHDRAWAL_HOURS");
    expect((await deposit(a.accountId, { amount: 1, currency: "CAD" })).statusCode).toBe(200);

    clock.now.mockReturnValue(new Date("2026-11-12T16:00:00Z")); // 11:00 Toronto
    expect((await withdraw(a.accountId, { amount: 1, currency: "CAD" })).statusCode).toBe(200);
    delete process.env.WITHDRAWAL_WINDOW_START;
    delete process.env.WITHDRAWAL_WINDOW_END;
  });
});

describe("Idempotency", () => {
  test("same key + same payload → applied once, original response replayed", async () => {
    const a = await newAccount({ balance: 100 });
    const key = uniqueKey();
    const first = await withdraw(a.accountId, { amount: 30, currency: "CAD" }, { "Idempotency-Key": key });
    const second = await withdraw(a.accountId, { amount: 30, currency: "CAD" }, { "Idempotency-Key": key });

    expect(first.json.balance).toBe(70);
    expect(second.statusCode).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(second.headers["Idempotent-Replayed"]).toBe("true");
    expect(second.headers["X-Transaction-Id"]).toBe(first.headers["X-Transaction-Id"]);
    expect(await balanceOf(a.accountId)).toBe(70); // debited ONCE
    expect((await ledgerFor(a.accountId)).filter((e) => e.type === "WITHDRAWAL")).toHaveLength(1);
  });

  test("same key + different payload → 422 IDEMPOTENCY_KEY_REUSED, nothing applied", async () => {
    const a = await newAccount({ balance: 100 });
    const key = uniqueKey();
    await withdraw(a.accountId, { amount: 30, currency: "CAD" }, { "Idempotency-Key": key });
    const res = await withdraw(a.accountId, { amount: 31, currency: "CAD" }, { "Idempotency-Key": key });
    expect(res.statusCode).toBe(422);
    expect(res.json.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await balanceOf(a.accountId)).toBe(70);
  });

  test("a rejected request is not cached: same key succeeds after the account is funded", async () => {
    const a = await newAccount({ balance: 10 });
    const key = uniqueKey();
    expect((await withdraw(a.accountId, { amount: 50, currency: "CAD" }, { "Idempotency-Key": key })).statusCode).toBe(409);
    await deposit(a.accountId, { amount: 100, currency: "CAD" });
    expect((await withdraw(a.accountId, { amount: 50, currency: "CAD" }, { "Idempotency-Key": key })).statusCode).toBe(200);
  });

  test("REQUIRE_IDEMPOTENCY_KEY=true → missing key 400, malformed key 400", async () => {
    process.env.REQUIRE_IDEMPOTENCY_KEY = "true";
    resetConfig();
    const a = await newAccount({ balance: 10 });
    expect((await deposit(a.accountId, { amount: 1, currency: "CAD" })).json.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await deposit(a.accountId, { amount: 1, currency: "CAD" }, { "Idempotency-Key": "bad key!" })).json.error).toBe(
      "INVALID_IDEMPOTENCY_KEY"
    );
    process.env.REQUIRE_IDEMPOTENCY_KEY = "false";
  });
});

describe("Transfers", () => {
  test("moves funds atomically: both balances + two ledger legs sharing one transactionId", async () => {
    const from = await newAccount({ balance: 100 });
    const to = await newAccount({ balance: 5 });
    const res = await transfer({ fromAccountId: from.accountId, toAccountId: to.accountId, amount: 30.25, currency: "CAD" });

    expect(res.statusCode).toBe(200);
    expect(res.json.fromAccount.balance).toBe(69.75);
    expect(res.json.toAccount.balance).toBe(35.25);

    const txnId = res.headers["X-Transaction-Id"];
    const status = await invoke(tx.status, apiEvent({ pathParameters: { transactionId: txnId } }));
    expect(status.json).toMatchObject({ transactionId: txnId, type: "TRANSFER", status: "COMPLETED", amount: 30.25 });
    expect(status.json.entries).toEqual([
      { accountId: from.accountId, direction: "DEBIT", balanceAfter: 69.75 },
      { accountId: to.accountId, direction: "CREDIT", balanceAfter: 35.25 },
    ]);
  });

  test("failure leaves BOTH accounts untouched (no partial transfer)", async () => {
    const from = await newAccount({ balance: 10 });
    const to = await newAccount({ balance: 0 });
    await setStatus("account", to.accountId, "CLOSED");
    const res = await transfer({ fromAccountId: from.accountId, toAccountId: to.accountId, amount: 5, currency: "CAD" });
    expect(res.statusCode).toBe(409);
    expect(await balanceOf(from.accountId)).toBe(10);
    expect(await balanceOf(to.accountId)).toBe(0);
  });

  test.each([
    ["insufficient funds", { balance: 1 }, { balance: 0 }, 409, "INSUFFICIENT_FUNDS"],
    ["currency mismatch between accounts", { balance: 50 }, { balance: 0, currency: "USD" }, 400, "CURRENCY_MISMATCH"],
  ])("%s", async (_n, fromSpec, toSpec, status, code) => {
    const from = await newAccount(fromSpec);
    const to = await newAccount(toSpec);
    const res = await transfer({ fromAccountId: from.accountId, toAccountId: to.accountId, amount: 5, currency: "CAD" });
    expect(res.statusCode).toBe(status);
    expect(res.json.error).toBe(code);
  });

  test("same account → 400; unknown destination → 404", async () => {
    const a = await newAccount({ balance: 50 });
    expect((await transfer({ fromAccountId: a.accountId, toAccountId: a.accountId, amount: 1, currency: "CAD" })).statusCode).toBe(400);
    expect((await transfer({ fromAccountId: a.accountId, toAccountId: "acct_nope", amount: 1, currency: "CAD" })).statusCode).toBe(404);
  });
});

describe("History & status", () => {
  test("history is newest-first and paginates with an opaque nextToken", async () => {
    const a = await newAccount({ balance: 100 });
    for (const amount of [1, 2, 3]) await deposit(a.accountId, { amount, currency: "CAD" });

    const page1 = await invoke(tx.history, apiEvent({ pathParameters: { accountId: a.accountId }, query: { limit: "2" } }));
    expect(page1.statusCode).toBe(200);
    expect(page1.json.items.map((i) => i.amount)).toEqual([3, 2]);
    expect(page1.json.nextToken).toEqual(expect.any(String));

    const page2 = await invoke(
      tx.history,
      apiEvent({ pathParameters: { accountId: a.accountId }, query: { limit: "2", nextToken: page1.json.nextToken } })
    );
    expect(page2.json.items.map((i) => i.type)).toEqual(["DEPOSIT", "ACCOUNT_OPENING"]);
  });

  test("a nextToken from another account is rejected (cursor tampering)", async () => {
    const a = await newAccount({ balance: 1 });
    const b = await newAccount({ balance: 1 });
    await deposit(a.accountId, { amount: 1, currency: "CAD" });
    const page = await invoke(tx.history, apiEvent({ pathParameters: { accountId: a.accountId }, query: { limit: "1" } }));
    const res = await invoke(tx.history, apiEvent({ pathParameters: { accountId: b.accountId }, query: { nextToken: page.json.nextToken } }));
    expect(res.statusCode).toBe(400);
  });

  test("unknown transaction id → 404", async () => {
    expect((await invoke(tx.status, apiEvent({ pathParameters: { transactionId: "txn_nope" } }))).statusCode).toBe(404);
  });
});
