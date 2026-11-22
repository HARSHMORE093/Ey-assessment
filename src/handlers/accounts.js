"use strict";

const { withHandler } = require("../middleware/withHandler");
const { validate, validatePathId } = require("../validators/validate");
const schemas = require("../validators/schemas");
const accountService = require("../services/accountService");
const { ok, json } = require("../lib/response");
const { notFound } = require("../lib/errors");

const customerIdFrom = (pathParam) => {
  const customerId = pathParam("customerId");
  return validatePathId(schemas.pathId, customerId, notFound(`Customer ${customerId} not found`));
};

/** POST /customers/{customerId}/accounts → 201 Account | 400 | 404 */
const create = withHandler(async ({ pathParam, body, headers, principal, requestId, log }) => {
  const customerId = customerIdFrom(pathParam);
  const input = validate(schemas.createAccount, body());
  const result = await accountService.createAccount({
    customerId,
    input,
    principal,
    rawKey: headers["idempotency-key"],
    requestId,
    log,
  });
  return json(result.statusCode, result.body, result.headers);
});

/** GET /customers/{customerId}/accounts → 200 { items } | 404 */
const list = withHandler(async ({ pathParam, principal }) => {
  const customerId = customerIdFrom(pathParam);
  return ok(await accountService.listAccounts({ customerId, principal }));
});

/** GET /accounts/{accountId} → 200 Account (with balance) | 404 */
const get = withHandler(async ({ pathParam, principal }) => {
  const accountId = pathParam("accountId");
  validatePathId(schemas.pathId, accountId, notFound(`Account ${accountId} not found`));
  return ok(await accountService.getAccount({ accountId, principal }));
});

module.exports = { create, list, get };
