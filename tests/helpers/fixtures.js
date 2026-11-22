"use strict";

const { UpdateCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../../src/lib/dynamodb");
const { getConfig } = require("../../src/config");
const customers = require("../../src/handlers/customers");
const accounts = require("../../src/handlers/accounts");
const { apiEvent, invoke } = require("./events");

/**
 * Each test builds its OWN customer + accounts through the real handlers, so test files can run
 * in parallel against the same tables without interfering with each other.
 */
async function newCustomer() {
  const res = await invoke(
    customers.create,
    apiEvent({ method: "POST", body: { fullName: "Test User", email: "test.user@example.com" } })
  );
  if (res.statusCode !== 201) throw new Error(`fixture customer failed: ${res.body}`);
  return res.json;
}

async function newAccount({ customerId, balance = 0, currency = "CAD", type = "CHECKING" } = {}) {
  const owner = customerId || (await newCustomer()).customerId;
  const res = await invoke(
    accounts.create,
    apiEvent({
      method: "POST",
      pathParameters: { customerId: owner },
      body: { type, currency, initialBalance: balance },
    })
  );
  if (res.statusCode !== 201) throw new Error(`fixture account failed: ${res.body}`);
  return res.json;
}

/** Direct DB tweak for states the API cannot produce (e.g. a CLOSED account / INACTIVE customer). */
async function setStatus(kind, id, status) {
  const tables = getConfig().tables;
  const [TableName, key] = kind === "account" ? [tables.accounts, { accountId: id }] : [tables.customers, { customerId: id }];
  await docClient.send(
    new UpdateCommand({
      TableName,
      Key: key,
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status },
    })
  );
}

/** All ledger entries for an account (eventually-consistent GSI is fine after awaits locally). */
async function ledgerFor(accountId) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: getConfig().tables.transactions,
      IndexName: getConfig().indexes.transactionsByAccount,
      KeyConditionExpression: "accountId = :a",
      ExpressionAttributeValues: { ":a": accountId },
    })
  );
  return res.Items;
}

module.exports = { newCustomer, newAccount, setStatus, ledgerFor };
