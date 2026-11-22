"use strict";

/**
 * Runs before each test file's modules load. Integration tests use their own Test_* tables on
 * DynamoDB Local, so running the suite never clobbers the data behind `npm start`.
 */
Object.assign(process.env, {
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "local",
  AWS_SECRET_ACCESS_KEY: "local",
  CUSTOMERS_TABLE: "Test_Customers",
  ACCOUNTS_TABLE: "Test_Accounts",
  TRANSACTIONS_TABLE: "Test_Transactions",
  IDEMPOTENCY_TABLE: "Test_IdempotencyKeys",
  BANK_TIMEZONE: "America/Toronto",
  WITHDRAWAL_WINDOW_START: "00:00",
  WITHDRAWAL_WINDOW_END: "24:00",
  DAILY_WITHDRAWAL_LIMIT_MINOR: "500000",
  REQUIRE_IDEMPOTENCY_KEY: "false",
  RATE_LIMIT_ENABLED: "false",
  AUTH_MODE: "none",
  OCC_MAX_ATTEMPTS: "10",
  OCC_BASE_DELAY_MS: "5",
  OCC_MAX_DELAY_MS: "100",
  LOG_LEVEL: "silent",
});
