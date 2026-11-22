"use strict";

const { zonedParts } = require("../lib/clock");
const { toMinor } = require("../lib/money");
const { conflict, badRequest } = require("../lib/errors");

/**
 * Pure business rules: no I/O, so each rule is unit-tested in isolation
 * (tests/unit/bankingRules.test.js). Every function is O(1) time and space.
 */

/** Current balance of a stored account in integer minor units. */
function balanceMinorOf(account) {
  const minor = toMinor(Number(account.balance));
  // A stored balance that is not a whole number of cents means data corruption.
  // Fail loudly (500) rather than move money on top of it.
  if (minor === null) throw new Error(`Corrupt balance on account ${account.accountId}`);
  return minor;
}

/** Inactive accounts cannot move money (BR: "prevent withdrawals from inactive accounts"). */
function assertAccountOpen(account) {
  if (account.status !== "OPEN") {
    throw conflict(`Account ${account.accountId} is not active`, "ACCOUNT_INACTIVE");
  }
}

function assertCurrencyMatches(account, currency) {
  if (account.currency !== currency) {
    throw badRequest(
      `Currency ${currency} does not match account currency ${account.currency}`,
      "CURRENCY_MISMATCH"
    );
  }
}

function assertSufficientFunds(balanceMinor, amountMinor) {
  if (balanceMinor < amountMinor) throw conflict("Insufficient funds", "INSUFFICIENT_FUNDS");
}

/**
 * Withdrawal window, e.g. 10:00-17:00 in the BANK's timezone (not the server's: Lambda runs in UTC).
 * Start is inclusive, end exclusive. A window that crosses midnight (22:00-06:00) is supported.
 */
function assertWithinWithdrawalWindow(now, { timezone, withdrawalWindowStartMin: start, withdrawalWindowEndMin: end }) {
  const { minutes } = zonedParts(now, timezone);
  const open = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!open) {
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    throw conflict(
      `Withdrawals are only permitted between ${fmt(start)} and ${fmt(end)} (${timezone})`,
      "OUTSIDE_WITHDRAWAL_HOURS"
    );
  }
}

/**
 * Daily withdrawal limit. The running total is stored ON the account item as
 * { date: "YYYY-MM-DD" (bank timezone), totalMinor }, so it is updated in the SAME
 * optimistic-locked write as the balance. Two concurrent withdrawals therefore cannot both
 * slip under the limit (that would be a race condition if the total lived elsewhere).
 *
 * The counter resets implicitly: if the stored date is not today's business date, the
 * total starts again from 0.
 *
 * Returns the new counter to persist.
 */
function nextDailyWithdrawal(account, now, amountMinor, banking) {
  const today = zonedParts(now, banking.timezone).date;
  const usedToday = account.dailyWithdrawal?.date === today ? account.dailyWithdrawal.totalMinor : 0;
  const limit = account.dailyWithdrawalLimitMinor ?? banking.dailyWithdrawalLimitMinor; // per-account override
  if (usedToday + amountMinor > limit) {
    const remaining = Math.max(0, limit - usedToday);
    throw conflict(
      `Daily withdrawal limit exceeded. Remaining today: ${(remaining / 100).toFixed(2)} ${account.currency}`,
      "DAILY_LIMIT_EXCEEDED"
    );
  }
  return { date: today, totalMinor: usedToday + amountMinor };
}

module.exports = {
  balanceMinorOf,
  assertAccountOpen,
  assertCurrencyMatches,
  assertSufficientFunds,
  assertWithinWithdrawalWindow,
  nextDailyWithdrawal,
};
