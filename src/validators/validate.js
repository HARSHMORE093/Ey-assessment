"use strict";

const { badRequest } = require("../lib/errors");

/**
 * Validate `input` against a Joi schema and return the normalised value,
 * or throw a 400 AppError whose message names the first failing field.
 */
function validate(schema, input, { allowUnknown = false } = {}) {
  const { value, error } = schema.validate(input, {
    abortEarly: true,
    allowUnknown,
    stripUnknown: false,
    convert: true, // only applies to non-strict rules (trim/lowercase/defaults); money fields are .strict()
    errors: { wrap: { label: false } },
  });
  if (error) throw badRequest(error.details[0].message, "VALIDATION_ERROR");
  return value;
}

/** Validate a path parameter. Garbage ids are 404s, not 400s, since the resource can't exist. */
function validatePathId(schema, id, notFoundError) {
  const { error } = schema.validate(id);
  if (error) throw notFoundError;
  return id;
}

module.exports = { validate, validatePathId };
