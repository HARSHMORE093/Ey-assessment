"use strict";

const { withHandler } = require("../../src/middleware/withHandler");
const { conflict } = require("../../src/lib/errors");
const { ok } = require("../../src/lib/response");
const { apiEvent, invoke } = require("../helpers/events");

describe("centralised error handling & request ids", () => {
  test("AppError → its status and the contract error shape { error, message } + requestId", async () => {
    const handler = withHandler(async () => {
      throw conflict("Insufficient funds", "INSUFFICIENT_FUNDS");
    });
    const res = await invoke(handler, apiEvent());
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({ error: "INSUFFICIENT_FUNDS", message: "Insufficient funds", requestId: expect.any(String) });
    expect(res.headers["X-Request-Id"]).toBe(res.json.requestId);
  });

  test("unexpected errors → 500 without leaking message or stack", async () => {
    const handler = withHandler(async () => {
      throw new Error("connect ECONNREFUSED 10.0.3.7:8000 secret-table-name");
    });
    const res = await invoke(handler, apiEvent());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/ECONNREFUSED|secret-table-name|at /);
    expect(res.json.error).toBe("INTERNAL_SERVER_ERROR");
  });

  test("DynamoDB throttling surfaces as retryable 503 (load shedding)", async () => {
    const handler = withHandler(async () => {
      const e = new Error("Rate exceeded");
      e.name = "ProvisionedThroughputExceededException";
      throw e;
    });
    const res = await invoke(handler, apiEvent());
    expect(res.statusCode).toBe(503);
    expect(res.headers["Retry-After"]).toBe("1");
  });

  test("a sane caller-supplied X-Request-Id is propagated, a malicious one replaced", async () => {
    const handler = withHandler(async () => ok({}));
    const good = await invoke(handler, apiEvent({ headers: { "X-Request-Id": "abc-12345678" } }));
    expect(good.headers["X-Request-Id"]).toBe("abc-12345678");
    const bad = await invoke(handler, apiEvent({ headers: { "X-Request-Id": "x\n{\"level\":\"error\"}" } }));
    expect(bad.headers["X-Request-Id"]).not.toMatch(/\n/);
  });

  test("security headers are set on every response (helmet-equivalent)", async () => {
    const res = await invoke(withHandler(async () => ok({})), apiEvent());
    expect(res.headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Strict-Transport-Security": expect.stringContaining("max-age"),
      "X-Frame-Options": "DENY",
    });
  });

  test.each([
    [undefined, "Request body is required"],
    ["{oops", "Request body must be valid JSON"],
    ["[1,2]", "Request body must be a JSON object"],
    [JSON.stringify({ a: "x".repeat(20000) }), "Request body too large"],
  ])("body parsing: %#", async (raw, message) => {
    const handler = withHandler(async ({ body }) => ok(body()));
    const res = await invoke(handler, { ...apiEvent(), body: raw ?? null });
    expect(res.statusCode).toBe(400);
    expect(res.json.message).toBe(message);
  });
});
