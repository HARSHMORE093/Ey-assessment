"use strict";

const customers = require("../../src/handlers/customers");
const accounts = require("../../src/handlers/accounts");
const { apiEvent, invoke, uniqueKey } = require("../helpers/events");
const { newCustomer, newAccount, setStatus, ledgerFor } = require("../helpers/fixtures");

describe("Customers (core)", () => {
  test("POST /customers → 201 Customer matching the contract", async () => {
    const res = await invoke(customers.create, apiEvent({ method: "POST", body: { fullName: "Grace Hopper", email: "Grace@Example.com" } }));
    expect(res.statusCode).toBe(201);
    expect(res.json).toEqual({
      customerId: expect.stringMatching(/^cust_/),
      fullName: "Grace Hopper",
      email: "grace@example.com",
      status: "ACTIVE",
      createdAt: expect.any(String),
    });
  });

  test("POST /customers without email → 400 { error, message }", async () => {
    const res = await invoke(customers.create, apiEvent({ method: "POST", body: { fullName: "No Email" } }));
    expect(res.statusCode).toBe(400);
    expect(res.json).toMatchObject({ error: expect.any(String), message: "email is required" });
  });

  test("GET /customers/{id} → 200, and 404 for an unknown id", async () => {
    const c = await newCustomer();
    const found = await invoke(customers.get, apiEvent({ pathParameters: { customerId: c.customerId } }));
    expect(found.statusCode).toBe(200);
    expect(found.json).toEqual(c);

    const missing = await invoke(customers.get, apiEvent({ pathParameters: { customerId: "does_not_exist" } }));
    expect(missing.statusCode).toBe(404);
    expect(missing.json).toMatchObject({ error: "NOT_FOUND", message: expect.any(String) });
  });

  test("Idempotency-Key on POST /customers: retry returns the same customer, nothing duplicated", async () => {
    const key = uniqueKey();
    const send = () =>
      invoke(customers.create, apiEvent({ method: "POST", headers: { "Idempotency-Key": key }, body: { fullName: "Retry Me", email: "r@example.com" } }));
    const first = await send();
    const second = await send();
    expect(second.statusCode).toBe(201);
    expect(second.json.customerId).toBe(first.json.customerId);
    expect(second.headers["Idempotent-Replayed"]).toBe("true");
  });
});

describe("Accounts (core)", () => {
  test("POST /customers/{id}/accounts → 201 Account, opening balance recorded in the ledger", async () => {
    const c = await newCustomer();
    const res = await invoke(
      accounts.create,
      apiEvent({ method: "POST", pathParameters: { customerId: c.customerId }, body: { type: "CHECKING", currency: "CAD", initialBalance: 40 } })
    );
    expect(res.statusCode).toBe(201);
    expect(res.json).toEqual({
      accountId: expect.stringMatching(/^acct_/),
      customerId: c.customerId,
      type: "CHECKING",
      currency: "CAD",
      balance: 40,
      status: "OPEN",
      createdAt: expect.any(String),
    });
    expect(res.json).not.toHaveProperty("version"); // internal fields never leak

    const ledger = await ledgerFor(res.json.accountId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "ACCOUNT_OPENING", direction: "CREDIT", amount: 40, balanceAfter: 40 });
  });

  test("initialBalance defaults to 0 (and no ledger entry for a zero opening)", async () => {
    const acct = await newAccount({ currency: "USD", type: "SAVINGS" });
    expect(acct.balance).toBe(0);
    expect(await ledgerFor(acct.accountId)).toHaveLength(0);
  });

  test("create account for unknown customer → 404; inactive customer → 409", async () => {
    const body = { type: "CHECKING", currency: "CAD" };
    const missing = await invoke(accounts.create, apiEvent({ method: "POST", pathParameters: { customerId: "cust_nope" }, body }));
    expect(missing.statusCode).toBe(404);

    const c = await newCustomer();
    await setStatus("customer", c.customerId, "INACTIVE");
    const inactive = await invoke(accounts.create, apiEvent({ method: "POST", pathParameters: { customerId: c.customerId }, body }));
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json.error).toBe("CUSTOMER_INACTIVE");
  });

  test("invalid account payloads → 400", async () => {
    const c = await newCustomer();
    for (const body of [{ type: "LOAN", currency: "CAD" }, { type: "CHECKING", currency: "EUR" }, { type: "CHECKING", currency: "CAD", initialBalance: -1 }]) {
      const res = await invoke(accounts.create, apiEvent({ method: "POST", pathParameters: { customerId: c.customerId }, body }));
      expect(res.statusCode).toBe(400);
    }
  });

  test("GET /customers/{id}/accounts → { items } via GSI query; 404 for unknown customer", async () => {
    const c = await newCustomer();
    const a1 = await newAccount({ customerId: c.customerId, balance: 1 });
    const a2 = await newAccount({ customerId: c.customerId, balance: 2, currency: "USD", type: "SAVINGS" });
    await newAccount({ balance: 3 }); // another customer's account must not appear

    const res = await invoke(accounts.list, apiEvent({ pathParameters: { customerId: c.customerId } }));
    expect(res.statusCode).toBe(200);
    expect(res.json.items.map((a) => a.accountId).sort()).toEqual([a1.accountId, a2.accountId].sort());

    const missing = await invoke(accounts.list, apiEvent({ pathParameters: { customerId: "cust_nope" } }));
    expect(missing.statusCode).toBe(404);
  });

  test("GET /accounts/{id} → 200 with numeric balance; 404 unknown", async () => {
    const acct = await newAccount({ balance: 12.34 });
    const res = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: acct.accountId } }));
    expect(res.statusCode).toBe(200);
    expect(res.json.balance).toBe(12.34);
    const missing = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: "acct_nope" } }));
    expect(missing.statusCode).toBe(404);
  });
});
