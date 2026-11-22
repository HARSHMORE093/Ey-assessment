"use strict";

const jwt = require("jsonwebtoken");
const { resetConfig } = require("../../src/config");
const customers = require("../../src/handlers/customers");
const accounts = require("../../src/handlers/accounts");
const tx = require("../../src/handlers/transactions");
const { apiEvent, invoke } = require("../helpers/events");
const { newCustomer, newAccount } = require("../helpers/fixtures");

/** End-to-end authorisation with AUTH_MODE=jwt against real tables. */
const SECRET = "integration-secret-at-least-32-characters-long";
const token = (claims) =>
  `Bearer ${jwt.sign(claims, SECRET, { algorithm: "HS256", issuer: "ey-banking-api", audience: "ey-banking-clients", expiresIn: "5m" })}`;

let alice; // customer
let aliceAcct;
let bobAcct;

beforeAll(async () => {
  // Fixtures are created in AUTH_MODE=none, then JWT is switched on.
  alice = await newCustomer();
  aliceAcct = await newAccount({ customerId: alice.customerId, balance: 100 });
  bobAcct = await newAccount({ balance: 100 });
  process.env.AUTH_MODE = "jwt";
  process.env.JWT_SECRET = SECRET;
  resetConfig();
});

afterAll(() => {
  process.env.AUTH_MODE = "none";
  delete process.env.JWT_SECRET;
  resetConfig();
});

const aliceHeaders = () => ({ Authorization: token({ sub: "alice", role: "CUSTOMER", customerId: alice.customerId }) });
const adminHeaders = () => ({ Authorization: token({ sub: "teller-1", role: "ADMIN" }) });

describe("JWT authentication & ownership", () => {
  test("no token → 401 with WWW-Authenticate", async () => {
    const res = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: aliceAcct.accountId } }));
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBe("Bearer");
  });

  test("customer reads own account → 200", async () => {
    const res = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: aliceAcct.accountId }, headers: aliceHeaders() }));
    expect(res.statusCode).toBe(200);
  });

  test("customer reading someone else's account → 404 (no existence leak)", async () => {
    const res = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: bobAcct.accountId }, headers: aliceHeaders() }));
    expect(res.statusCode).toBe(404);
  });

  test("customer cannot withdraw from someone else's account", async () => {
    const res = await invoke(
      tx.withdraw,
      apiEvent({ method: "POST", pathParameters: { accountId: bobAcct.accountId }, body: { amount: 1, currency: "CAD" }, headers: aliceHeaders() })
    );
    expect(res.statusCode).toBe(404);
  });

  test("customer can transfer FROM own account TO someone else's; not the reverse", async () => {
    const pay = await invoke(
      tx.transfer,
      apiEvent({ method: "POST", body: { fromAccountId: aliceAcct.accountId, toAccountId: bobAcct.accountId, amount: 1, currency: "CAD" }, headers: aliceHeaders() })
    );
    expect(pay.statusCode).toBe(200);
    // payer must not learn the payee's balance through the status endpoint
    const status = await invoke(tx.status, apiEvent({ pathParameters: { transactionId: pay.headers["X-Transaction-Id"] }, headers: aliceHeaders() }));
    const payeeLeg = status.json.entries.find((e) => e.accountId === bobAcct.accountId);
    expect(payeeLeg).not.toHaveProperty("balanceAfter");

    const steal = await invoke(
      tx.transfer,
      apiEvent({ method: "POST", body: { fromAccountId: bobAcct.accountId, toAccountId: aliceAcct.accountId, amount: 1, currency: "CAD" }, headers: aliceHeaders() })
    );
    expect(steal.statusCode).toBe(404);
  });

  test("customer cannot list another customer's accounts (403) or register customers (403)", async () => {
    const other = await invoke(accounts.list, apiEvent({ pathParameters: { customerId: "cust_001" }, headers: aliceHeaders() }));
    expect(other.statusCode).toBe(403);
    const reg = await invoke(customers.create, apiEvent({ method: "POST", body: { fullName: "X", email: "x@y.zz" }, headers: aliceHeaders() }));
    expect(reg.statusCode).toBe(403);
  });

  test("admin (bank staff) can register customers and read any account", async () => {
    const reg = await invoke(customers.create, apiEvent({ method: "POST", body: { fullName: "X", email: "x@y.zz" }, headers: adminHeaders() }));
    expect(reg.statusCode).toBe(201);
    const any = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: bobAcct.accountId }, headers: adminHeaders() }));
    expect(any.statusCode).toBe(200);
  });

  test("a token signed with the wrong key is rejected", async () => {
    const forged = `Bearer ${jwt.sign({ sub: "alice", role: "ADMIN" }, "attacker-key-attacker-key-attacker-key", { issuer: "ey-banking-api", audience: "ey-banking-clients" })}`;
    const res = await invoke(accounts.get, apiEvent({ pathParameters: { accountId: bobAcct.accountId }, headers: { Authorization: forged } }));
    expect(res.statusCode).toBe(401);
  });
});
