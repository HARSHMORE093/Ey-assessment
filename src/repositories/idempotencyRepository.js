"use strict";

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../lib/dynamodb");
const { getConfig } = require("../config");

/**
 * IdempotencyKeys table: PK idempotencyKey (sha256 of caller scope + client key).
 * `expiresAt` (epoch seconds) is the table's TTL attribute, so DynamoDB deletes old keys for free.
 * TTL deletion is lazy (it can lag by hours), which is why expiry is also checked in code.
 */
const table = () => getConfig().tables.idempotency;

async function get(idempotencyKey) {
  const res = await docClient.send(
    new GetCommand({ TableName: table(), Key: { idempotencyKey }, ConsistentRead: true })
  );
  return res.Item || null;
}

/**
 * Transaction item: claim the key. Succeeds only if the key was never used, or if its previous
 * use has expired. Committed together with the money movement, so "key recorded" and
 * "money moved" are the same atomic fact.
 */
function buildPut(record, nowEpochSeconds) {
  return {
    Put: {
      TableName: table(),
      Item: record,
      ConditionExpression: "attribute_not_exists(idempotencyKey) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": nowEpochSeconds },
    },
  };
}

module.exports = { get, buildPut };
