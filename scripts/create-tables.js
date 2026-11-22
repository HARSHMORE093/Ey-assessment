"use strict";

const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} = require("@aws-sdk/client-dynamodb");

/**
 * Creates the 4 tables used by the API on DynamoDB Local.
 * The same schema is declared for real AWS in infra/lib/banking-stack.js. Keep them in sync.
 *
 *   Customers        PK customerId
 *   Accounts         PK accountId               GSI CustomerIdIndex (customerId)
 *   Transactions     PK transactionId, SK accountId   GSI AccountHistoryIndex (accountId, createdAt)
 *   IdempotencyKeys  PK idempotencyKey          (TTL on expiresAt in AWS)
 */

function tableNames(env = process.env) {
  return {
    customers: env.CUSTOMERS_TABLE || "Customers",
    accounts: env.ACCOUNTS_TABLE || "Accounts",
    transactions: env.TRANSACTIONS_TABLE || "Transactions",
    idempotency: env.IDEMPOTENCY_TABLE || "IdempotencyKeys",
  };
}

function definitions(names) {
  return [
    {
      TableName: names.customers,
      AttributeDefinitions: [{ AttributeName: "customerId", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    },
    {
      TableName: names.accounts,
      AttributeDefinitions: [
        { AttributeName: "accountId", AttributeType: "S" },
        { AttributeName: "customerId", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "accountId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "CustomerIdIndex",
          KeySchema: [{ AttributeName: "customerId", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    },
    {
      TableName: names.transactions,
      AttributeDefinitions: [
        { AttributeName: "transactionId", AttributeType: "S" },
        { AttributeName: "accountId", AttributeType: "S" },
        { AttributeName: "createdAt", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "transactionId", KeyType: "HASH" },
        { AttributeName: "accountId", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "AccountHistoryIndex",
          KeySchema: [
            { AttributeName: "accountId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" },
    },
    {
      TableName: names.idempotency,
      AttributeDefinitions: [{ AttributeName: "idempotencyKey", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "idempotencyKey", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    },
  ];
}

function makeClient(env = process.env) {
  return new DynamoDBClient({
    region: env.AWS_REGION || "us-east-1",
    endpoint: env.DYNAMODB_ENDPOINT || "http://localhost:8000",
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID || "local",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY || "local",
    },
  });
}

async function tableExists(client, tableName) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

async function recreateTable(client, definition, log = console.log) {
  const { TableName } = definition;
  if (await tableExists(client, TableName)) {
    log(`Deleting existing table: ${TableName}`);
    await client.send(new DeleteTableCommand({ TableName }));
    await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName });
  }
  log(`Creating table: ${TableName}`);
  await client.send(new CreateTableCommand(definition));
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName });
}

async function createTables({ env = process.env, log = console.log } = {}) {
  const client = makeClient(env);
  for (const def of definitions(tableNames(env))) {
    await recreateTable(client, def, log);
  }
  log("Tables ready.");
}

module.exports = { createTables, tableNames, definitions };

if (require.main === module) {
  createTables().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
