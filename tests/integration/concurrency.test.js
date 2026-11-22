"use strict";

const tx = require("../../src/handlers/transactions");
const accounts = require("../../src/handlers/accounts");
const { apiEvent, invoke, uniqueKey } = require("../helpers/events");
const { newAccount, ledgerFor } = require("../helpers/fixtures");

/**
 * Race conditions against a REAL DynamoDB engine (DynamoDB Local). Requests are fired with
 * Promise.all so reads and writes genuinely interleave.
 */
const withdraw = (accountId, amount, headers) =>
  invoke(tx.withdraw, apiEvent({ method: "POST", pathParameters: { accountId }, body: { amount, currency: "CAD" }, headers }));
const deposit = (accountId, amount) =>
  invoke(tx.deposit, apiEvent({ method: "POST", pathParameters: { accountId }, body: { amount, currency: "CAD" } }));
const transfer = (from, to, amount) =>
  invoke(tx.transfer, apiEvent({ method: "POST", body: { fromAccountId: from, toAccountId: to, amount, currency: "CAD" } }));
const balanceOf = async (accountId) => (await invoke(accounts.get, apiEvent({ pathParameters: { accountId } }))).json.balance;

/** Invariant of an auditable ledger: balance == sum(credits) - sum(debits). */
async function ledgerBalance(accountId) {
  const entries = await ledgerFor(accountId);
  return entries.reduce((sum, e) => sum + Math.round(e.amount * 100) * (e.direction === "CREDIT" ? 1 : -1), 0) / 100;
}

jest.setTimeout(30000);

describe("Isolation: concurrent requests", () => {
  test("20 concurrent withdrawals of 30 from 250 → never overdrawn, no lost updates", async () => {
    const a = await newAccount({ balance: 250 });
    const results = await Promise.all(Array.from({ length: 20 }, () => withdraw(a.accountId, 30)));

    const ok = results.filter((r) => r.statusCode === 200).length;
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(ok + rejected.length).toBe(20); // every request got a definitive answer
    rejected.forEach((r) => expect(["INSUFFICIENT_FUNDS", "CONCURRENT_UPDATE"]).toContain(r.json.error));

    // At most 8 can succeed (8 * 30 = 240 ≤ 250 < 270). Typically exactly 8. Fewer only if a
    // request exhausted its bounded retries (CONCURRENT_UPDATE), which is safe: it moved no money.
    const exhausted = rejected.filter((r) => r.json.error === "CONCURRENT_UPDATE").length;
    expect(ok).toBeLessThanOrEqual(8);
    if (exhausted === 0) expect(ok).toBe(8);

    const balance = await balanceOf(a.accountId);
    expect(balance).toBe(250 - 30 * ok); // no lost update, no double debit
    expect(balance).toBeGreaterThanOrEqual(0); // never overdrawn
    expect(await ledgerBalance(a.accountId)).toBe(balance); // ledger and balance agree
  });

  test("concurrent deposits are all applied exactly once (no lost update)", async () => {
    const a = await newAccount({ balance: 0 });
    const results = await Promise.all(Array.from({ length: 15 }, () => deposit(a.accountId, 1.1)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await balanceOf(a.accountId)).toBe(16.5); // 15 * 1.10, exact
    expect(await ledgerBalance(a.accountId)).toBe(16.5);
  });

  test("Idempotency under concurrency: 10 identical requests in flight → exactly ONE debit", async () => {
    const a = await newAccount({ balance: 100 });
    const key = uniqueKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => withdraw(a.accountId, 40, { "Idempotency-Key": key })));

    expect(results.every((r) => r.statusCode === 200)).toBe(true); // every client sees success…
    expect(new Set(results.map((r) => r.headers["X-Transaction-Id"])).size).toBe(1); // …of the SAME transaction
    expect(await balanceOf(a.accountId)).toBe(60); // …and money moved once
    expect((await ledgerFor(a.accountId)).filter((e) => e.type === "WITHDRAWAL")).toHaveLength(1);
  });

  test("Deadlock scenario: A→B and B→A transfers at the same time all resolve, money is conserved", async () => {
    const A = await newAccount({ balance: 500 });
    const B = await newAccount({ balance: 500 });
    const ops = [];
    for (let i = 0; i < 10; i += 1) {
      ops.push(transfer(A.accountId, B.accountId, 7));
      ops.push(transfer(B.accountId, A.accountId, 3));
    }
    const results = await Promise.all(ops); // with lock-based DBs this pattern is the textbook deadlock

    // Every request finishes (nothing hangs); each either commits or fails cleanly.
    results.forEach((r) => expect([200, 409]).toContain(r.statusCode));
    const total = (await balanceOf(A.accountId)) + (await balanceOf(B.accountId));
    expect(total).toBe(1000); // conservation of money: no partial transfer ever committed
    expect(await ledgerBalance(A.accountId)).toBe(await balanceOf(A.accountId));
    expect(await ledgerBalance(B.accountId)).toBe(await balanceOf(B.accountId));
  });

  test("mixed concurrent traffic keeps ledger == balance", async () => {
    const a = await newAccount({ balance: 100 });
    const b = await newAccount({ balance: 100 });
    await Promise.all([
      ...Array.from({ length: 5 }, () => deposit(a.accountId, 10)),
      ...Array.from({ length: 5 }, () => withdraw(a.accountId, 15)),
      ...Array.from({ length: 5 }, () => transfer(a.accountId, b.accountId, 5)),
    ]);
    const balance = await balanceOf(a.accountId);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(await ledgerBalance(a.accountId)).toBe(balance);
    expect((await balanceOf(a.accountId)) + (await balanceOf(b.accountId))).toBe(
      (await ledgerBalance(a.accountId)) + (await ledgerBalance(b.accountId))
    );
  });
});
