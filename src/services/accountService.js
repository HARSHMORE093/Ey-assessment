"use strict";

const crypto = require("crypto");
const customerRepository = require("../repositories/customerRepository");
const accountRepository = require("../repositories/accountRepository");
const ledgerRepository = require("../repositories/ledgerRepository");
const transactWriter = require("../repositories/transactWriter");
const idempotencyService = require("./idempotencyService");
const { toAccountDto } = require("./mappers");
const { notFound, conflict } = require("../lib/errors");
const { clock } = require("../lib/clock");
const { toMinor, toMajor } = require("../lib/money");
const { withOptimisticRetry } = require("../lib/retry");
const { getConfig } = require("../config");
const { assertCustomerAccess, assertAccountAccess } = require("../middleware/auth");
const { requestToken } = require("./requestToken");

/**
 * Open a new account for an existing, ACTIVE customer.
 *
 * Atomic in one TransactWriteItems:
 *   - ConditionCheck: customer still exists and is ACTIVE at commit time
 *     (closes the check-then-act race if the customer is deactivated concurrently)
 *   - Put account (version 0)
 *   - Put ACCOUNT_OPENING ledger entry when initialBalance > 0, so even the opening
 *     balance is auditable (sum(ledger) == balance holds for every account)
 *   - Put idempotency record (when an Idempotency-Key was sent)
 */
async function createAccount({ customerId, input, principal, rawKey, requestId, log }) {
  assertCustomerAccess(principal, customerId);

  return idempotencyService.execute(
    { rawKey, principal, payload: { op: "CREATE_ACCOUNT", customerId, ...input }, log },
    (idem) =>
      withOptimisticRetry(
        async (attempt) => {
          const customer = await customerRepository.getById(customerId);
          if (!customer) throw notFound(`Customer ${customerId} not found`);
          if (customer.status !== "ACTIVE") throw conflict(`Customer ${customerId} is not active`, "CUSTOMER_INACTIVE");

          const now = clock.now().toISOString();
          const openingMinor = toMinor(input.initialBalance);
          const account = {
            accountId: `acct_${crypto.randomUUID()}`,
            customerId,
            type: input.type,
            currency: input.currency,
            balance: toMajor(openingMinor),
            status: "OPEN",
            createdAt: now,
            updatedAt: now,
            version: 0,
          };
          const result = { statusCode: 201, body: toAccountDto(account) };

          const items = [customerRepository.buildActiveCheck(customerId), accountRepository.buildCreate(account)];
          let transactionId;
          if (openingMinor > 0) {
            transactionId = `txn_${crypto.randomUUID()}`;
            items.push(
              ledgerRepository.buildPut({
                transactionId,
                accountId: account.accountId,
                customerId,
                type: "ACCOUNT_OPENING",
                direction: "CREDIT",
                amount: toMajor(openingMinor),
                currency: account.currency,
                balanceAfter: account.balance,
                status: "COMPLETED",
                createdAt: now,
                actor: principal.sub,
                requestId,
              })
            );
            result.headers = { "X-Transaction-Id": transactionId };
          }

          await transactWriter.commit({
            items,
            idempotencyItem: idem.buildItem(result, transactionId),
            clientRequestToken: requestToken(requestId, attempt),
          });

          log.audit("ACCOUNT_OPENED", { accountId: account.accountId, customerId, transactionId });
          return result;
        },
        { ...getConfig().concurrency, log }
      )
  );
}

/** List a customer's accounts: 404 when the customer does not exist (contract), else { items }. */
async function listAccounts({ customerId, principal }) {
  assertCustomerAccess(principal, customerId);
  const customer = await customerRepository.getById(customerId);
  if (!customer) throw notFound(`Customer ${customerId} not found`);

  const accounts = await accountRepository.listByCustomer(customerId);
  // GSI has no sort key → order is undefined; sort for a stable, predictable response. O(k log k).
  accounts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.accountId.localeCompare(b.accountId));
  return { items: accounts.map(toAccountDto) };
}

/** Get one account including its balance (strongly consistent read). */
async function getAccount({ accountId, principal }) {
  const account = await accountRepository.getById(accountId);
  if (!account) throw notFound(`Account ${accountId} not found`);
  assertAccountAccess(principal, account, `Account ${accountId} not found`);
  return toAccountDto(account);
}

module.exports = { createAccount, listAccounts, getAccount };
