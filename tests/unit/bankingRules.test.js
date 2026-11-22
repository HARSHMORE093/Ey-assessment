"use strict";

const rules = require("../../src/services/bankingRules");

const banking = {
  timezone: "America/Toronto",
  withdrawalWindowStartMin: 10 * 60, // 10:00
  withdrawalWindowEndMin: 17 * 60, // 17:00
  dailyWithdrawalLimitMinor: 100000, // 1,000.00
};

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.error;
  }
};

describe("withdrawal window (bank timezone, DST-aware)", () => {
  test("10:30 Toronto in summer (EDT, UTC-4) is inside 10:00-17:00", () => {
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-07-15T14:30:00Z"), banking))).toBeNull();
  });

  test("the SAME UTC instant in winter (EST, UTC-5) is 09:30 → rejected", () => {
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-15T14:30:00Z"), banking))).toBe(
      "OUTSIDE_WITHDRAWAL_HOURS"
    );
  });

  test("start is inclusive, end is exclusive", () => {
    // 2026-12-15 is EST (UTC-5): 15:00Z = 10:00 local, 22:00Z = 17:00 local
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-15T15:00:00Z"), banking))).toBeNull();
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-15T21:59:00Z"), banking))).toBeNull();
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-15T22:00:00Z"), banking))).toBe(
      "OUTSIDE_WITHDRAWAL_HOURS"
    );
  });

  test("overnight window 22:00-06:00 wraps midnight", () => {
    const night = { ...banking, withdrawalWindowStartMin: 22 * 60, withdrawalWindowEndMin: 6 * 60 };
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-16T04:00:00Z"), night))).toBeNull(); // 23:00
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-16T09:00:00Z"), night))).toBeNull(); // 04:00
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-16T17:00:00Z"), night))).toBe(
      "OUTSIDE_WITHDRAWAL_HOURS"
    ); // 12:00
  });

  test("00:00-24:00 means always open", () => {
    const always = { ...banking, withdrawalWindowStartMin: 0, withdrawalWindowEndMin: 1440 };
    expect(codeOf(() => rules.assertWithinWithdrawalWindow(new Date("2026-12-16T04:59:00Z"), always))).toBeNull();
  });
});

describe("daily withdrawal limit", () => {
  const account = { accountId: "a", currency: "CAD" };

  test("accumulates within the same business day", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    const first = rules.nextDailyWithdrawal(account, now, 60000, banking);
    expect(first).toEqual({ date: "2026-11-12", totalMinor: 60000 });
    const second = rules.nextDailyWithdrawal({ ...account, dailyWithdrawal: first }, now, 40000, banking);
    expect(second.totalMinor).toBe(100000); // exactly at the limit is allowed
  });

  test("rejects the withdrawal that would exceed the limit", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    const used = { ...account, dailyWithdrawal: { date: "2026-11-12", totalMinor: 99999 } };
    expect(codeOf(() => rules.nextDailyWithdrawal(used, now, 2, banking))).toBe("DAILY_LIMIT_EXCEEDED");
  });

  test("resets at midnight in the BANK timezone, not UTC", () => {
    const used = { ...account, dailyWithdrawal: { date: "2026-11-11", totalMinor: 100000 } };
    // 04:59Z = 23:59 on Nov 11 in Toronto → still Nov 11, limit exhausted
    expect(codeOf(() => rules.nextDailyWithdrawal(used, new Date("2026-11-12T04:59:00Z"), 1, banking))).toBe(
      "DAILY_LIMIT_EXCEEDED"
    );
    // 05:00Z = 00:00 on Nov 12 in Toronto → new business day, counter restarts
    expect(rules.nextDailyWithdrawal(used, new Date("2026-11-12T05:00:00Z"), 1, banking)).toEqual({
      date: "2026-11-12",
      totalMinor: 1,
    });
  });

  test("per-account override wins over the global default", () => {
    const vip = { ...account, dailyWithdrawalLimitMinor: 10000000 };
    expect(rules.nextDailyWithdrawal(vip, new Date(), 500000, banking).totalMinor).toBe(500000);
  });
});

describe("other rules", () => {
  test("inactive account", () => {
    expect(codeOf(() => rules.assertAccountOpen({ accountId: "x", status: "CLOSED" }))).toBe("ACCOUNT_INACTIVE");
  });
  test("insufficient funds", () => {
    expect(codeOf(() => rules.assertSufficientFunds(100, 101))).toBe("INSUFFICIENT_FUNDS");
    expect(codeOf(() => rules.assertSufficientFunds(100, 100))).toBeNull(); // emptying the account is fine
  });
  test("currency mismatch", () => {
    expect(codeOf(() => rules.assertCurrencyMatches({ currency: "CAD" }, "USD"))).toBe("CURRENCY_MISMATCH");
  });
  test("corrupt stored balance fails loudly", () => {
    expect(() => rules.balanceMinorOf({ accountId: "x", balance: 1.234 })).toThrow(/Corrupt balance/);
  });
});
