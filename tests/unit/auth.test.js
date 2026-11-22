"use strict";

const jwt = require("jsonwebtoken");
const { resetConfig } = require("../../src/config");
const auth = require("../../src/middleware/auth");

const SECRET = "unit-test-secret-that-is-at-least-32-characters";
const sign = (claims, opts = {}) =>
  jwt.sign(claims, SECRET, { algorithm: "HS256", issuer: "ey-banking-api", audience: "ey-banking-clients", expiresIn: "5m", ...opts });
const bearer = (t) => ({ authorization: `Bearer ${t}` });

describe("authentication", () => {
  beforeAll(() => {
    process.env.AUTH_MODE = "jwt";
    process.env.JWT_SECRET = SECRET;
    resetConfig();
  });
  afterAll(() => {
    process.env.AUTH_MODE = "none";
    delete process.env.JWT_SECRET;
    resetConfig();
  });

  test("valid customer token → principal", async () => {
    const p = await auth.authenticate({}, bearer(sign({ sub: "u1", role: "CUSTOMER", customerId: "cust_001" })));
    expect(p).toEqual({ sub: "u1", role: "CUSTOMER", customerId: "cust_001" });
  });

  test.each([
    ["missing header", {}],
    ["not a bearer token", { authorization: "Basic abc" }],
    ["garbage token", bearer("abc.def.ghi")],
    ["expired token", bearer(sign({ sub: "u", role: "ADMIN" }, { expiresIn: -60 }))],
    ["wrong audience", bearer(sign({ sub: "u", role: "ADMIN" }, { audience: "someone-else" }))],
    ["wrong signing key", bearer(jwt.sign({ sub: "u", role: "ADMIN" }, "x".repeat(40), { issuer: "ey-banking-api", audience: "ey-banking-clients" }))],
    ["alg:none (unsigned) token", bearer(jwt.sign({ sub: "u", role: "ADMIN" }, null, { algorithm: "none", issuer: "ey-banking-api", audience: "ey-banking-clients" }))],
  ])("%s → 401", async (_name, headers) => {
    await expect(auth.authenticate({}, headers)).rejects.toMatchObject({ statusCode: 401, error: "UNAUTHORIZED" });
  });

  test("unknown role → 403", async () => {
    await expect(auth.authenticate({}, bearer(sign({ sub: "u", role: "ROOT" })))).rejects.toMatchObject({ statusCode: 403 });
  });

  test("customer token without a customerId binding → 403", async () => {
    await expect(auth.authenticate({}, bearer(sign({ sub: "u", role: "CUSTOMER" })))).rejects.toMatchObject({ statusCode: 403 });
  });

  test("a short / missing signing key is a server misconfiguration, never 'auth off'", async () => {
    process.env.JWT_SECRET = "short";
    resetConfig();
    await expect(auth.authenticate({}, bearer("x.y.z"))).rejects.toThrow(/JWT signing key/);
    process.env.JWT_SECRET = SECRET;
    resetConfig();
  });
});

describe("authorisation", () => {
  const customer = { sub: "u1", role: "CUSTOMER", customerId: "cust_001" };
  const admin = { sub: "a", role: "ADMIN", customerId: null };

  test("customer can access own customer record only (403 otherwise)", () => {
    expect(() => auth.assertCustomerAccess(customer, "cust_001")).not.toThrow();
    expect(() => auth.assertCustomerAccess(customer, "cust_002")).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => auth.assertCustomerAccess(admin, "cust_002")).not.toThrow();
  });

  test("someone else's account looks like 404 (no account-id enumeration)", () => {
    expect(() => auth.assertAccountAccess(customer, { customerId: "cust_002" })).toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
    expect(() => auth.assertAccountAccess(customer, { customerId: "cust_001" })).not.toThrow();
  });

  test("role check", () => {
    expect(() => auth.requireRole(customer, "ADMIN")).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => auth.requireRole(admin, "ADMIN")).not.toThrow();
  });

  test("AUTH_MODE=none yields the local admin principal", async () => {
    process.env.AUTH_MODE = "none";
    resetConfig();
    await expect(auth.authenticate({}, {})).resolves.toMatchObject({ role: "ADMIN" });
  });
});
