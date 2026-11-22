"use strict";

/**
 * Mint a short-lived HS256 JWT for LOCAL testing with AUTH_MODE=jwt.
 * In production, tokens are issued by the identity provider (e.g. Cognito), never by a script.
 *
 *   JWT_SECRET=... npm run token -- --role CUSTOMER --customerId cust_001
 *   JWT_SECRET=... npm run token -- --role ADMIN
 */
const jwt = require("jsonwebtoken");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.error("Set JWT_SECRET (>= 32 chars), the same value the API runs with.");
  process.exit(1);
}

const role = args.role || "CUSTOMER";
if (role === "CUSTOMER" && !args.customerId) {
  console.error("--customerId is required for CUSTOMER tokens");
  process.exit(1);
}

const token = jwt.sign(
  { sub: args.sub || `${role.toLowerCase()}-${args.customerId || "staff"}`, role, customerId: args.customerId },
  secret,
  {
    algorithm: "HS256",
    issuer: process.env.JWT_ISSUER || "ey-banking-api",
    audience: process.env.JWT_AUDIENCE || "ey-banking-clients",
    expiresIn: args.expiresIn || "15m",
  }
);
console.log(token);
