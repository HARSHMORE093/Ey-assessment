"use strict";

/**
 * Persistence → API mappers. They are an explicit allow-list: internal attributes
 * (version, dailyWithdrawal, limits, actor ids …) can never leak into a response by accident.
 */

function toCustomerDto(c) {
  return {
    customerId: c.customerId,
    fullName: c.fullName,
    email: c.email,
    status: c.status,
    createdAt: c.createdAt,
  };
}

function toAccountDto(a) {
  return {
    accountId: a.accountId,
    customerId: a.customerId,
    type: a.type,
    currency: a.currency,
    balance: Number(a.balance),
    status: a.status,
    createdAt: a.createdAt,
  };
}

/** One ledger entry as seen in an account's history. */
function toLedgerEntryDto(e) {
  return {
    transactionId: e.transactionId,
    type: e.type,
    direction: e.direction,
    amount: Number(e.amount),
    currency: e.currency,
    balanceAfter: Number(e.balanceAfter),
    status: e.status,
    counterpartyAccountId: e.counterpartyAccountId,
    createdAt: e.createdAt,
  };
}

/**
 * Transaction status view, built from all legs of a transaction.
 * `canSeeBalance(leg)` hides the other party's balance from a customer viewing a transfer
 * they sent or received (privacy: a payer must never learn the payee's balance).
 */
function toTransactionDto(legs, canSeeBalance) {
  const [first] = legs;
  return {
    transactionId: first.transactionId,
    type: first.type,
    status: first.status,
    amount: Number(first.amount),
    currency: first.currency,
    createdAt: first.createdAt,
    entries: legs
      .slice()
      .sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "DEBIT" ? -1 : 1))
      .map((leg) => ({
        accountId: leg.accountId,
        direction: leg.direction,
        ...(canSeeBalance(leg) ? { balanceAfter: Number(leg.balanceAfter) } : {}),
      })),
  };
}

module.exports = { toCustomerDto, toAccountDto, toLedgerEntryDto, toTransactionDto };
