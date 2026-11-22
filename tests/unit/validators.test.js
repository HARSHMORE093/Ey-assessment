"use strict";

const schemas = require("../../src/validators/schemas");
const { validate } = require("../../src/validators/validate");

const err = (schema, input) => {
  try {
    validate(schema, input);
    return null;
  } catch (e) {
    return e.message;
  }
};

describe("request validation (mirrors openapi.yaml)", () => {
  test("customer: normalises email, requires both fields", () => {
    expect(validate(schemas.createCustomer, { fullName: "  Ada ", email: " Ada@Example.COM " })).toEqual({
      fullName: "Ada",
      email: "ada@example.com",
    });
    expect(err(schemas.createCustomer, { fullName: "No Email" })).toBe("email is required");
    expect(err(schemas.createCustomer, { fullName: "", email: "a@b.co" })).toMatch(/fullName/);
    expect(err(schemas.createCustomer, { fullName: "A", email: "not-an-email" })).toMatch(/email/);
    expect(err(schemas.createCustomer, { fullName: "A", email: "a@b.co", role: "ADMIN" })).toBe("role is not allowed"); // mass-assignment guard
  });

  test("account: enums and initialBalance default 0", () => {
    expect(validate(schemas.createAccount, { type: "SAVINGS", currency: "USD" }).initialBalance).toBe(0);
    expect(err(schemas.createAccount, { type: "LOAN", currency: "USD" })).toMatch(/type/);
    expect(err(schemas.createAccount, { type: "SAVINGS", currency: "EUR" })).toMatch(/currency/);
    expect(err(schemas.createAccount, { type: "SAVINGS", currency: "USD", initialBalance: -1 })).toMatch(/>= 0/);
  });

  test.each([
    [{ amount: 0, currency: "CAD" }, /greater than 0/],
    [{ amount: -5, currency: "CAD" }, /greater than 0/],
    [{ amount: "10", currency: "CAD" }, /must be a number/], // no silent coercion of money
    [{ amount: 10.123, currency: "CAD" }, /2 decimal places/],
    [{ amount: 1e15, currency: "CAD" }, /maximum/],
    [{ amount: 10 }, /currency is required/],
  ])("amount request rejects %j", (input, message) => {
    expect(err(schemas.amountRequest, input)).toMatch(message);
  });

  test("history query coerces limit from query-string text and bounds it", () => {
    expect(validate(schemas.historyQuery, { limit: "5" }).limit).toBe(5);
    expect(err(schemas.historyQuery, { limit: "1000" })).toMatch(/limit/);
  });
});
