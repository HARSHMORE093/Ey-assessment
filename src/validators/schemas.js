"use strict";

const Joi = require("joi");
const { toMinor } = require("../lib/money");
const { getConfig } = require("../config");

/**
 * Request schemas mirror openapi/openapi.yaml. Validation is strict:
 *  - unknown fields are rejected, so a typo like "ammount" fails loudly
 *  - no type coercion: "10" (a string) is NOT accepted as an amount
 *  - money must have at most 2 decimals and is converted to integer minor units here,
 *    so services only ever see integers
 */

const CURRENCIES = ["CAD", "USD"];
const ACCOUNT_TYPES = ["CHECKING", "SAVINGS"];

/** Joi extension point: amount → integer cents, enforcing ≤2 decimals and an upper bound. */
function moneyField({ allowZero }) {
  return Joi.number()
    .strict()
    .custom((value, helpers) => {
      // Magnitude first: a huge number would otherwise overflow to "not a safe integer" and get a misleading message.
      if (Math.abs(value) * 100 > getConfig().banking.maxAmountMinor) {
        return helpers.message("{{#label}} exceeds the maximum allowed");
      }
      const minor = toMinor(value);
      if (minor === null) return helpers.message("{{#label}} must have at most 2 decimal places");
      if (allowZero ? minor < 0 : minor <= 0) {
        return helpers.message(allowZero ? "{{#label}} must be >= 0" : "{{#label}} must be greater than 0");
      }
      if (minor > getConfig().banking.maxAmountMinor) return helpers.message("{{#label}} exceeds the maximum allowed");
      return value;
    });
}

const createCustomer = Joi.object({
  fullName: Joi.string().trim().min(1).max(200).required(),
  email: Joi.string().trim().lowercase().max(254).email({ tlds: { allow: false } }).required(),
});

const createAccount = Joi.object({
  type: Joi.string().valid(...ACCOUNT_TYPES).required(),
  currency: Joi.string().valid(...CURRENCIES).required(),
  initialBalance: moneyField({ allowZero: true }).default(0),
});

const amountRequest = Joi.object({
  amount: moneyField({ allowZero: false }).required(),
  currency: Joi.string().valid(...CURRENCIES).required(),
});

const transferRequest = Joi.object({
  fromAccountId: Joi.string().trim().min(1).max(64).required(),
  toAccountId: Joi.string().trim().min(1).max(64).required(),
  amount: moneyField({ allowZero: false }).required(),
  currency: Joi.string().valid(...CURRENCIES).required(),
});

const historyQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20), // query strings arrive as text, coercion allowed here
  nextToken: Joi.string().max(2048),
});

/** Path ids: bounded, URL-safe. Rejects garbage before it reaches DynamoDB. */
const pathId = Joi.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).required();

/** Idempotency-Key header format (IETF draft-ietf-httpapi-idempotency-key-header). */
const idempotencyKey = Joi.string().pattern(/^[A-Za-z0-9_\-:.]{8,128}$/);

module.exports = {
  createCustomer,
  createAccount,
  amountRequest,
  transferRequest,
  historyQuery,
  pathId,
  idempotencyKey,
};
