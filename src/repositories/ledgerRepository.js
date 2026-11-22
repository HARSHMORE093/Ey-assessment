"use strict";

const { QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../lib/dynamodb");
const { getConfig } = require("../config");

/**
 * Transactions (ledger) table: append-only, immutable audit trail.
 *
 *   PK transactionId, SK accountId
 *     deposit / withdrawal / account opening → 1 item
 *     transfer                               → 2 items (DEBIT leg + CREDIT leg), same transactionId
 *
 *   GSI AccountHistoryIndex: PK accountId, SK createdAt → per-account history, newest first.
 *
 * Entries are only ever Put (with attribute_not_exists), never updated or deleted.
 * A correction would be a new compensating entry, as in real double-entry bookkeeping.
 */
const table = () => getConfig().tables.transactions;

function buildPut(entry) {
  return {
    Put: {
      TableName: table(),
      Item: entry,
      ConditionExpression: "attribute_not_exists(transactionId)",
    },
  };
}

/**
 * Transaction status lookup by id: Query on the base-table partition, strongly consistent.
 * A client that just received a transaction id can always read it back immediately.
 */
async function getByTransactionId(transactionId) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "transactionId = :id",
      ExpressionAttributeValues: { ":id": transactionId },
      ConsistentRead: true,
    })
  );
  return res.Items || [];
}

/**
 * Account history, newest first, paginated with DynamoDB's LastEvaluatedKey.
 * GSI read → eventually consistent; an entry committed a few ms ago may appear on the next call.
 * O(limit) per page.
 */
async function listByAccount(accountId, { limit, exclusiveStartKey }) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: table(),
      IndexName: getConfig().indexes.transactionsByAccount,
      KeyConditionExpression: "accountId = :aid",
      ExpressionAttributeValues: { ":aid": accountId },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    })
  );
  return { items: res.Items || [], lastEvaluatedKey: res.LastEvaluatedKey };
}

module.exports = { buildPut, getByTransactionId, listByAccount };
