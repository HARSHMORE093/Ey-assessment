"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

/**
 * Seeds the ids referenced by ASSESSMENT.md and the grader's Postman collection:
 *   customers cust_001, cust_002 · accounts acct_001, acct_002, acct_003
 * plus acct_004 (CLOSED) to demonstrate the "inactive account" rule.
 *
 * `version: 0` initialises the optimistic-locking counter. The code also accepts items
 * without it (treated as version 0), so data seeded by the original template still works.
 */

const now = new Date().toISOString();

const customers = [
  { customerId: "cust_001", fullName: "Ada Lovelace", email: "ada@example.com", status: "ACTIVE", createdAt: now },
  { customerId: "cust_002", fullName: "Alan Turing", email: "alan@example.com", status: "ACTIVE", createdAt: now },
];

const account = (accountId, customerId, type, currency, balance, status = "OPEN") => ({
  accountId,
  customerId,
  type,
  currency,
  balance,
  status,
  createdAt: now,
  updatedAt: now,
  version: 0,
});

const accounts = [
  account("acct_001", "cust_001", "CHECKING", "CAD", 250.0),
  account("acct_002", "cust_001", "SAVINGS", "CAD", 1000.0),
  account("acct_003", "cust_002", "CHECKING", "USD", 75.5),
  account("acct_004", "cust_002", "SAVINGS", "USD", 10.0, "CLOSED"),
];

async function seed({ env = process.env, log = console.log } = {}) {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: env.AWS_REGION || "us-east-1",
      endpoint: env.DYNAMODB_ENDPOINT || "http://localhost:8000",
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID || "local",
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY || "local",
      },
    })
  );
  const customersTable = env.CUSTOMERS_TABLE || "Customers";
  const accountsTable = env.ACCOUNTS_TABLE || "Accounts";

  for (const c of customers) {
    await client.send(new PutCommand({ TableName: customersTable, Item: c }));
    log(`Seeded customer ${c.customerId}`);
  }
  for (const a of accounts) {
    await client.send(new PutCommand({ TableName: accountsTable, Item: a }));
    log(`Seeded account ${a.accountId} (${a.status})`);
  }
  log("Seed complete.");
}

module.exports = { seed, customers, accounts };

if (require.main === module) {
  seed()
    .then(() => {
      console.log("Try: GET http://localhost:3000/customers/cust_001");
      console.log("     GET http://localhost:3000/accounts/acct_001");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
