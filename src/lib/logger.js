"use strict";

/**
 * Minimal structured (JSON) logger.
 *
 * - One JSON object per line, so CloudWatch Logs Insights can filter on fields
 *   (e.g. `filter requestId = "..."`).
 * - PII protection: known sensitive keys are masked or removed before anything is written.
 *   We never log request bodies, tokens or e-mail addresses in clear text.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const REDACT_KEYS = new Set(["authorization", "password", "token", "jwt", "secret", "jwtsecret"]);
const MASK_KEYS = new Set(["email", "fullname"]);

function maskValue(key, value) {
  if (typeof value !== "string") return "[REDACTED]";
  if (key === "email") {
    const [user, domain] = value.split("@");
    return domain ? `${user.slice(0, 1)}***@${domain}` : "***";
  }
  return `${value.slice(0, 1)}***`;
}

function sanitize(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (REDACT_KEYS.has(key)) out[k] = "[REDACTED]";
    else if (MASK_KEYS.has(key)) out[k] = maskValue(key, v);
    else out[k] = sanitize(v, depth + 1);
  }
  return out;
}

function threshold() {
  return LEVELS[process.env.LOG_LEVEL || "info"] ?? LEVELS.info;
}

function write(level, message, context = {}) {
  if (LEVELS[level] < threshold()) return;
  const entry = { level, time: new Date().toISOString(), message, ...sanitize(context) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

/** Returns a child logger that stamps every line with the given fields (e.g. requestId). */
function child(bindings) {
  return {
    debug: (m, c) => write("debug", m, { ...bindings, ...c }),
    info: (m, c) => write("info", m, { ...bindings, ...c }),
    warn: (m, c) => write("warn", m, { ...bindings, ...c }),
    error: (m, c) => write("error", m, { ...bindings, ...c }),
    /** Audit trail entry for security-relevant / money-moving actions. */
    audit: (action, c) => write("info", "AUDIT", { ...bindings, audit: true, action, ...c }),
    child: (more) => child({ ...bindings, ...more }),
  };
}

module.exports = { logger: child({}), sanitize };
