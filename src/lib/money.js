"use strict";

/**
 * Money handling.
 *
 * The OpenAPI contract exposes amounts/balances as decimal `number`s in MAJOR units
 * (e.g. 75.5 CAD). JavaScript numbers are IEEE-754 doubles, so 0.1 + 0.2 !== 0.3.
 *
 * Rule used throughout the code base:
 *   1. Convert to integer MINOR units (cents) the moment an amount enters the system.
 *   2. Do ALL arithmetic and comparisons on integers.
 *   3. Convert back to major units only when writing the `balance` attribute or responding.
 *
 * Integer cents are exact up to Number.MAX_SAFE_INTEGER (~90 trillion dollars).
 * DynamoDB stores Numbers as exact decimals (up to 38 digits), so the round trip
 * cents → n/100 → DynamoDB → n/100 → cents is loss-free.
 */

const MINOR_UNITS = { CAD: 2, USD: 2 };
const SCALE = 100;

/**
 * Convert a major-unit decimal (e.g. 10.25) to integer minor units (1025).
 * Returns null when the value has more than 2 decimal places or is not finite.
 * Time O(1), space O(1).
 */
function toMinor(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  // String(n) is the SHORTEST decimal that round-trips to the same double, i.e. exactly what
  // the client typed in JSON ("10.25" → "10.25", "10.005" → "10.005", 1e-7 → "1e-7").
  // Counting digits on that string is exact; a float tolerance check (|x*100 - round(x*100)| < ε)
  // breaks down for large amounts where one ULP is bigger than ε.
  const text = String(Math.abs(amount));
  if (text.includes("e")) return null; // exponent form only appears for <1e-6 or ≥1e21: never a valid amount
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 2) return null; // sub-cent precision is not allowed for CAD/USD
  const minor = Number(whole) * SCALE + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  return amount < 0 ? -minor : minor;
}

/** Integer minor units → major-unit number (1025 → 10.25). */
function toMajor(minor) {
  return minor / SCALE;
}

module.exports = { toMinor, toMajor, MINOR_UNITS };
