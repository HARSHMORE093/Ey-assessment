"use strict";

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

/**
 * Secrets Manager access with per-container caching.
 *
 * The secret is fetched ONCE per cold start, and the in-flight Promise is cached, so
 * concurrent first calls share a single network request. That avoids paying Secrets
 * Manager latency (and its API rate limits) on every invocation. Rotation is picked up
 * when Lambda recycles containers. For faster rotation, add a TTL to the cache.
 */
let client;
const cache = new Map();

function getSecret(secretArn) {
  if (!cache.has(secretArn)) {
    client = client || new SecretsManagerClient({});
    const promise = client
      .send(new GetSecretValueCommand({ SecretId: secretArn }))
      .then((res) => res.SecretString)
      .catch((err) => {
        cache.delete(secretArn); // don't cache failures: let the next invocation try again
        throw err;
      });
    cache.set(secretArn, promise);
  }
  return cache.get(secretArn);
}

module.exports = { getSecret };
