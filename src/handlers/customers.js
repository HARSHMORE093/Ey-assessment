"use strict";

const { withHandler } = require("../middleware/withHandler");
const { validate, validatePathId } = require("../validators/validate");
const schemas = require("../validators/schemas");
const customerService = require("../services/customerService");
const { ok, json } = require("../lib/response");
const { notFound } = require("../lib/errors");

/**
 * Thin Lambda handlers (API Gateway → Lambda): parse → validate → call service → respond.
 * No business logic and no DynamoDB calls live here.
 */

/** POST /customers → 201 Customer | 400 */
const create = withHandler(async ({ body, headers, principal, requestId, log }) => {
  const input = validate(schemas.createCustomer, body());
  const result = await customerService.createCustomer({
    input,
    principal,
    rawKey: headers["idempotency-key"],
    requestId,
    log,
  });
  return json(result.statusCode, result.body, result.headers);
});

/** GET /customers/{customerId} → 200 Customer | 404 */
const get = withHandler(async ({ pathParam, principal }) => {
  const customerId = pathParam("customerId");
  validatePathId(schemas.pathId, customerId, notFound(`Customer ${customerId} not found`));
  return ok(await customerService.getCustomer({ customerId, principal }));
});

module.exports = { create, get };
