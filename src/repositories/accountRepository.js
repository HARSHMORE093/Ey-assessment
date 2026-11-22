"use strict";

const { GetCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../lib/dynamodb");
const { getConfig } = require("../config");

const table = () => getConfig().tables.accounts;
const MAX_LIST_PAGES = 10; // a customer has a handful of accounts; this bounds a pathological case

/**
 * Access pattern: get account by id (includes balance).
 * ConsistentRead = true, so the balance we validate against is never stale. Money decisions
 * must not be based on an eventually-consistent read. O(1).
 */
async function getById(accountId) {
  const res = await docClient.send(
    new GetCommand({ TableName: table(), Key: { accountId }, ConsistentRead: true })
  );
  return res.Item || null;
}

/**
 * Access pattern: list a customer's accounts → Query on GSI `CustomerIdIndex` (customerId).
 * Query reads only that customer's items: O(k) for k accounts. A Scan would read the WHOLE
 * table, O(n), and cost grows with every customer the bank adds.
 *
 * EVENTUAL CONSISTENCY: GSIs are always eventually consistent (ConsistentRead is not
 * supported on a GSI), so an account created milliseconds ago may not appear yet. That is
 * acceptable for a listing. Balances used for decisions always come from getById above.
 */
async function listByCustomer(customerId) {
  const { accountsByCustomer } = getConfig().indexes;
  const items = [];
  let startKey;
  let pages = 0;
  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: table(),
        IndexName: accountsByCustomer,
        KeyConditionExpression: "customerId = :cid",
        ExpressionAttributeValues: { ":cid": customerId },
        ExclusiveStartKey: startKey,
      })
    );
    items.push(...(res.Items || []));
    startKey = res.LastEvaluatedKey;
    pages += 1;
  } while (startKey && pages < MAX_LIST_PAGES);
  return items;
}

/** Transaction item: insert a new account (never overwrite). */
function buildCreate(account) {
  return {
    Put: {
      TableName: table(),
      Item: account,
      ConditionExpression: "attribute_not_exists(accountId)",
    },
  };
}

/**
 * Transaction item: OPTIMISTIC-LOCKING update (isolation against race conditions).
 *
 * We read the account (version v), validate the business rules in code, then write ONLY IF
 * the version is still v, and bump it to v+1. If any other request changed the account in
 * between, the condition fails, the whole transaction is cancelled, and we retry from a fresh
 * read. Lost updates are therefore impossible: two concurrent withdrawals of 100 from a
 * balance of 150 cannot both succeed.
 *
 * Items written before versioning existed (e.g. seed data) have no `version` attribute. They
 * are treated as version 0 via attribute_not_exists.
 *
 * `status = OPEN` is re-checked at commit time as defence in depth.
 */
function buildVersionedUpdate(account, { balance, dailyWithdrawal, updatedAt }) {
  const expectedVersion = account.version ?? 0;
  const names = { "#version": "version", "#status": "status" };
  const values = {
    ":balance": balance,
    ":next": expectedVersion + 1,
    ":updatedAt": updatedAt,
    ":open": "OPEN",
  };
  let set = "balance = :balance, #version = :next, updatedAt = :updatedAt";
  if (dailyWithdrawal) {
    set += ", dailyWithdrawal = :daily";
    values[":daily"] = dailyWithdrawal;
  }

  let condition = "#status = :open AND ";
  if (account.version === undefined) {
    condition += "attribute_not_exists(#version)";
  } else {
    condition += "#version = :expected";
    values[":expected"] = expectedVersion;
  }

  return {
    Update: {
      TableName: table(),
      Key: { accountId: account.accountId },
      UpdateExpression: `SET ${set}`,
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

module.exports = { getById, listByCustomer, buildCreate, buildVersionedUpdate };
