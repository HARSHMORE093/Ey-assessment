"use strict";

const { withHandler } = require("../middleware/withHandler");
const { validate, validatePathId } = require("../validators/validate");
const schemas = require("../validators/schemas");
const transactionService = require("../services/transactionService");
const { ok, json } = require("../lib/response");
const { notFound } = require("../lib/errors");

const accountIdFrom = (pathParam) => {
  const accountId = pathParam("accountId");
  return validatePathId(schemas.pathId, accountId, notFound(`Account ${accountId} not found`));
};

/** Builds a POST handler for deposit / withdrawal (same request shape, different service call). */
const amountHandler = (serviceFn) =>
  withHandler(async ({ pathParam, body, headers, principal, requestId, log }) => {
    const accountId = accountIdFrom(pathParam);
    const input = validate(schemas.amountRequest, body());
    const result = await serviceFn({
      accountId,
      input,
      principal,
      rawKey: headers["idempotency-key"],
      requestId,
      log,
    });
    return json(result.statusCode, result.body, result.headers);
  });

/** POST /accounts/{accountId}/deposits → 200 Account | 400 | 404 | 409 */
const deposit = amountHandler(transactionService.deposit);

/** POST /accounts/{accountId}/withdrawals → 200 Account | 400 | 404 | 409 */
const withdraw = amountHandler(transactionService.withdraw);

/** POST /transfers → 200 { fromAccount, toAccount } | 400 | 404 | 409 */
const transfer = withHandler(async ({ body, headers, principal, requestId, log }) => {
  const input = validate(schemas.transferRequest, body());
  const result = await transactionService.transfer({
    input,
    principal,
    rawKey: headers["idempotency-key"],
    requestId,
    log,
  });
  return json(result.statusCode, result.body, result.headers);
});

/** GET /accounts/{accountId}/transactions?limit=&nextToken= → 200 { items, nextToken } */
const history = withHandler(async ({ pathParam, query, principal }) => {
  const accountId = accountIdFrom(pathParam);
  const { limit, nextToken } = validate(schemas.historyQuery, query());
  return ok(await transactionService.listTransactions({ accountId, principal, limit, nextToken }));
});

/** GET /transactions/{transactionId} → 200 Transaction | 404 */
const status = withHandler(async ({ pathParam, principal }) => {
  const transactionId = pathParam("transactionId");
  validatePathId(schemas.pathId, transactionId, notFound(`Transaction ${transactionId} not found`));
  return ok(await transactionService.getTransaction({ transactionId, principal }));
});

module.exports = { deposit, withdraw, transfer, history, status };
