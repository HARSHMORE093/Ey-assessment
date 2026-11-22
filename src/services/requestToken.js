"use strict";

const { sha256 } = require("../lib/hash");

/**
 * DynamoDB ClientRequestToken (max 36 chars) for one write attempt.
 * Stable across SDK-internal retries of the same attempt (same requestId + attempt), so an
 * ambiguous timeout is safe. Different per optimistic-retry attempt, because each attempt
 * writes different values and DynamoDB rejects a reused token with a different payload.
 */
function requestToken(requestId, attempt) {
  return sha256(`${requestId}|${attempt}`).slice(0, 36);
}

module.exports = { requestToken };
