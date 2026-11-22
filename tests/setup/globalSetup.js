"use strict";

/**
 * Integration tests need DynamoDB Local (`npm run db:up`). Tables are recreated once per run.
 */
module.exports = async () => {
  require("./env");
  const { createTables } = require("../../scripts/create-tables");
  try {
    await createTables({ log: () => {} });
  } catch (err) {
    throw new Error(
      `Integration tests need DynamoDB Local at ${process.env.DYNAMODB_ENDPOINT}. Run "npm run db:up" first.\n${err.message}`
    );
  }
};
