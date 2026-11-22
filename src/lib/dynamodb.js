"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { getConfig } = require("../config");

/**
 * ONE client per Lambda container, created at module load (outside the handler).
 * Warm invocations reuse it, so TLS handshakes and keep-alive sockets are reused too.
 * That is the single cheapest latency win in Lambda.
 */

const endpoint = process.env.DYNAMODB_ENDPOINT;

const clientConfig = {
  region: process.env.AWS_REGION || "us-east-1",
  // Back-pressure on DynamoDB: "adaptive" retry mode adds a client-side token bucket that
  // slows this container down when DynamoDB returns throttling errors, instead of hammering
  // the table with immediate retries (which turns a hot spot into an outage).
  retryMode: "adaptive",
  maxAttempts: 3,
  // Fail fast: a stuck socket must not eat the whole Lambda timeout.
  requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
};

// Only point at DynamoDB Local when explicitly configured. In AWS the endpoint and the
// credentials come from the Lambda execution role. Hard-coding "localhost" here
// would break the deployed function.
if (endpoint) {
  clientConfig.endpoint = endpoint;
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "local",
  };
}

const client = new DynamoDBClient(clientConfig);

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// Kept for backwards compatibility with the template's helper signature.
const TABLES = {
  get customers() {
    return getConfig().tables.customers;
  },
  get accounts() {
    return getConfig().tables.accounts;
  },
  get transactions() {
    return getConfig().tables.transactions;
  },
  get idempotency() {
    return getConfig().tables.idempotency;
  },
};

module.exports = { client, docClient, TABLES };
