"use strict";

const { sanitize } = require("../../src/lib/logger");

describe("PII-safe logging", () => {
  test("masks PII and redacts secrets, recursively", () => {
    const out = sanitize({
      email: "ada@example.com",
      fullName: "Ada Lovelace",
      nested: { authorization: "Bearer abc.def", password: "p" },
      accountId: "acct_001",
    });
    expect(out).toEqual({
      email: "a***@example.com",
      fullName: "A***",
      nested: { authorization: "[REDACTED]", password: "[REDACTED]" },
      accountId: "acct_001",
    });
  });
});
