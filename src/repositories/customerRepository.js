"use strict";

const { GetCommand } = require("@aws-sdk/lib-dynamodb");
const { docClient } = require("../lib/dynamodb");
const { getConfig } = require("../config");

const table = () => getConfig().tables.customers;

/** Access pattern: get customer by id. GetItem on the partition key, O(1). */
async function getById(customerId) {
  const res = await docClient.send(
    new GetCommand({ TableName: table(), Key: { customerId }, ConsistentRead: true })
  );
  return res.Item || null;
}

/** Transaction item: insert a new customer, never overwrite an existing id. */
function buildCreate(customer) {
  return {
    Put: {
      TableName: table(),
      Item: customer,
      ConditionExpression: "attribute_not_exists(customerId)",
    },
  };
}

/**
 * Transaction item: assert (atomically, at commit time) that the customer still exists and is ACTIVE.
 * Prevents opening an account for a customer deactivated between our read and our write.
 */
function buildActiveCheck(customerId) {
  return {
    ConditionCheck: {
      TableName: table(),
      Key: { customerId },
      ConditionExpression: "attribute_exists(customerId) AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "ACTIVE" },
    },
  };
}

module.exports = { getById, buildCreate, buildActiveCheck };
