"use strict";

const crypto = require("crypto");

/**
 * Deterministic JSON: object keys sorted recursively, so {a:1,b:2} and {b:2,a:1}
 * produce the same fingerprint. Used to detect "same Idempotency-Key, different payload".
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

module.exports = { canonicalJson, sha256 };
