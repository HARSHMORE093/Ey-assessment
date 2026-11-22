"use strict";

const crypto = require("crypto");
const accountRepository = require("../repositories/accountRepository");
const ledgerRepository = require("../repositories/ledgerRepository");
const transactWriter = require("../repositories/transactWriter");
const idempotencyService = require("./idempotencyService");
const rules = require("./bankingRules");
const { toAccountDto, toLedgerEntryDto, toTransactionDto } = require("./mappers");
const { notFound, badRequest } = require("../lib/errors");
const { clock } = require("../lib/clock");
const { toMinor, toMajor } = require("../lib/money");
const { withOptimisticRetry } = require("../lib/retry");
const { getConfig } = require("../config");
const { assertAccountAccess, ROLES } = require("../middleware/auth");
const { requestToken } = require("./requestToken");

/**
 * Every money movement follows the same 4 steps:
 *
 *   READ      strongly consistent read of the account(s), including `version`
 *   VALIDATE  business rules in integer minor units (status, currency, hours, funds, daily limit)
 *   COMMIT    ONE TransactWriteItems: versioned balance update(s) + ledger entry(ies)
 *             + idempotency record, all or nothing
 *   RETRY     if the version changed underneath us (another request won the race), start again
 *             from READ with jittered exponential backoff, bounded attempts
 *
 * This is optimistic concurrency control. Isolation is per account and serialisable: the
 * rules are always evaluated against the exact state that the write replaces.
 */

async function loadOwnedAccount(accountId, principal) {
  const account = await accountRepository.getById(accountId);
  if (!account) throw notFound(`Account ${accountId} not found`);
  assertAccountAccess(principal, account, `Account ${accountId} not found`);
  return account;
}

function ledgerEntry(base, account, direction, balanceAfterMinor, extra = {}) {
  return {
    ...base,
    accountId: account.accountId,
    customerId: account.customerId, // used to authorise status lookups by the account owner
    direction,
    balanceAfter: toMajor(balanceAfterMinor),
    ...extra,
  };
}

/** Shared implementation for deposit (CREDIT) and withdrawal (DEBIT). */
function moveFunds(kind) {
  const isWithdrawal = kind === "WITHDRAWAL";

  return async ({ accountId, input, principal, rawKey, requestId, log }) => {
    const { banking, concurrency } = getConfig();
    const amountMinor = toMinor(input.amount);

    return idempotencyService.execute(
      { rawKey, principal, payload: { op: kind, accountId, ...input }, enforce: true, log },
      (idem) =>
        withOptimisticRetry(
          async (attempt) => {
            // READ
            const account = await loadOwnedAccount(accountId, principal);

            // VALIDATE (order matters: cheapest / most fundamental first)
            rules.assertAccountOpen(account);
            rules.assertCurrencyMatches(account, input.currency);
            const nowDate = clock.now();
            const balanceMinor = rules.balanceMinorOf(account);
            let dailyWithdrawal;
            if (isWithdrawal) {
              rules.assertWithinWithdrawalWindow(nowDate, banking);
              rules.assertSufficientFunds(balanceMinor, amountMinor);
              dailyWithdrawal = rules.nextDailyWithdrawal(account, nowDate, amountMinor, banking);
            }
            const newBalanceMinor = isWithdrawal ? balanceMinor - amountMinor : balanceMinor + amountMinor;

            // Build the new state and the response BEFORE committing, so the stored idempotent
            // response is exactly what this transaction produced.
            const now = nowDate.toISOString();
            const transactionId = `txn_${crypto.randomUUID()}`;
            const updated = { ...account, balance: toMajor(newBalanceMinor) };
            const result = {
              statusCode: 200,
              body: toAccountDto(updated),
              headers: { "X-Transaction-Id": transactionId },
            };

            // COMMIT
            await transactWriter.commit({
              items: [
                accountRepository.buildVersionedUpdate(account, {
                  balance: updated.balance,
                  dailyWithdrawal,
                  updatedAt: now,
                }),
                ledgerRepository.buildPut(
                  ledgerEntry(
                    {
                      transactionId,
                      type: kind,
                      amount: toMajor(amountMinor),
                      currency: input.currency,
                      status: "COMPLETED",
                      createdAt: now,
                      actor: principal.sub,
                      requestId,
                    },
                    account,
                    isWithdrawal ? "DEBIT" : "CREDIT",
                    newBalanceMinor
                  )
                ),
              ],
              idempotencyItem: idem.buildItem(result, transactionId),
              clientRequestToken: requestToken(requestId, attempt),
            });

            log.audit(kind, { accountId, transactionId, amountMinor, attempt });
            return result;
          },
          { ...concurrency, log }
        )
    );
  };
}

const deposit = moveFunds("DEPOSIT");
const withdraw = moveFunds("WITHDRAWAL");

/**
 * Transfer between two accounts: debit + credit + 2 ledger legs + idempotency record in ONE
 * transaction. There is no partial-failure window: either both balances change or neither does.
 *
 * Assumptions (documented in NOTES.md):
 *  - both accounts must hold the request currency (no FX)
 *  - the caller must own the SOURCE account; the destination can belong to anyone
 *  - transfers are not cash withdrawals, so banking hours / daily cash limit do not apply
 */
async function transfer({ input, principal, rawKey, requestId, log }) {
  const { fromAccountId, toAccountId, currency } = input;
  if (fromAccountId === toAccountId) {
    throw badRequest("fromAccountId and toAccountId must be different", "SAME_ACCOUNT_TRANSFER");
  }
  const amountMinor = toMinor(input.amount);
  const { concurrency } = getConfig();

  return idempotencyService.execute(
    { rawKey, principal, payload: { op: "TRANSFER", ...input }, enforce: true, log },
    (idem) =>
      withOptimisticRetry(
        async (attempt) => {
          // READ both in parallel (two independent GetItems)
          const [from, to] = await Promise.all([
            loadOwnedAccount(fromAccountId, principal),
            accountRepository.getById(toAccountId),
          ]);
          if (!to) throw notFound(`Account ${toAccountId} not found`);

          // VALIDATE
          rules.assertAccountOpen(from);
          rules.assertAccountOpen(to);
          rules.assertCurrencyMatches(from, currency);
          rules.assertCurrencyMatches(to, currency);
          const fromBalance = rules.balanceMinorOf(from);
          const toBalance = rules.balanceMinorOf(to);
          rules.assertSufficientFunds(fromBalance, amountMinor);

          const now = clock.now().toISOString();
          const transactionId = `txn_${crypto.randomUUID()}`;
          const fromAfter = { ...from, balance: toMajor(fromBalance - amountMinor) };
          const toAfter = { ...to, balance: toMajor(toBalance + amountMinor) };
          const result = {
            statusCode: 200,
            body: { fromAccount: toAccountDto(fromAfter), toAccount: toAccountDto(toAfter) },
            headers: { "X-Transaction-Id": transactionId },
          };

          const base = {
            transactionId,
            type: "TRANSFER",
            amount: toMajor(amountMinor),
            currency,
            status: "COMPLETED",
            createdAt: now,
            actor: principal.sub,
            requestId,
          };

          // Canonical ordering by accountId (lock-ordering discipline, see transactWriter.js).
          const legs = [
            { account: from, balance: fromAfter.balance, entry: ledgerEntry(base, from, "DEBIT", fromBalance - amountMinor, { counterpartyAccountId: to.accountId }) },
            { account: to, balance: toAfter.balance, entry: ledgerEntry(base, to, "CREDIT", toBalance + amountMinor, { counterpartyAccountId: from.accountId }) },
          ].sort((a, b) => a.account.accountId.localeCompare(b.account.accountId));

          // COMMIT (4 items + idempotency record, one atomic transaction)
          await transactWriter.commit({
            items: [
              ...legs.map((l) => accountRepository.buildVersionedUpdate(l.account, { balance: l.balance, updatedAt: now })),
              ...legs.map((l) => ledgerRepository.buildPut(l.entry)),
            ],
            idempotencyItem: idem.buildItem(result, transactionId),
            clientRequestToken: requestToken(requestId, attempt),
          });

          log.audit("TRANSFER", { fromAccountId, toAccountId, transactionId, amountMinor, attempt });
          return result;
        },
        { ...concurrency, log }
      )
  );
}

/** Opaque pagination cursor = base64url(JSON(LastEvaluatedKey)). */
const encodeCursor = (key) => (key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined);
function decodeCursor(token, accountId) {
  if (!token) return undefined;
  let key;
  try {
    key = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw badRequest("nextToken is invalid", "INVALID_PAGINATION_TOKEN");
  }
  // Tamper protection: a cursor must belong to the account being queried, otherwise a crafted
  // token could start reading another account's partition.
  if (!key || typeof key !== "object" || key.accountId !== accountId) {
    throw badRequest("nextToken is invalid", "INVALID_PAGINATION_TOKEN");
  }
  return key;
}

/** Transaction history for an account, newest first. */
async function listTransactions({ accountId, principal, limit, nextToken }) {
  await loadOwnedAccount(accountId, principal); // 404 + ownership before touching the ledger
  const page = await ledgerRepository.listByAccount(accountId, {
    limit,
    exclusiveStartKey: decodeCursor(nextToken, accountId),
  });
  return { items: page.items.map(toLedgerEntryDto), nextToken: encodeCursor(page.lastEvaluatedKey) };
}

/** Transaction status lookup. Visible to admins and to the owner of any leg. */
async function getTransaction({ transactionId, principal }) {
  const legs = await ledgerRepository.getByTransactionId(transactionId);
  const isAdmin = principal.role === ROLES.ADMIN;
  const owns = (leg) => isAdmin || leg.customerId === principal.customerId;
  if (legs.length === 0 || !legs.some(owns)) throw notFound(`Transaction ${transactionId} not found`);
  return toTransactionDto(legs, owns);
}

module.exports = { deposit, withdraw, transfer, listTransactions, getTransaction };
