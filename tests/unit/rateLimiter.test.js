"use strict";

const { resetConfig } = require("../../src/config");
const rateLimiter = require("../../src/middleware/rateLimiter");
const { withHandler } = require("../../src/middleware/withHandler");
const { ok } = require("../../src/lib/response");
const { apiEvent, invoke } = require("../helpers/events");

describe("token bucket rate limiter (back-pressure)", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_BURST = "3";
    process.env.RATE_LIMIT_RPS = "1";
    resetConfig();
    rateLimiter.resetRateLimiter();
  });
  afterAll(() => {
    process.env.RATE_LIMIT_ENABLED = "false";
    resetConfig();
  });

  test("allows a burst up to capacity, then throws 429 with Retry-After", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimiter.take("client-a", t0);
    expect(() => rateLimiter.take("client-a", t0)).toThrow(expect.objectContaining({ statusCode: 429 }));
  });

  test("refills over time", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimiter.take("client-a", t0);
    expect(() => rateLimiter.take("client-a", t0 + 1000)).not.toThrow(); // 1 token after 1s at 1 rps
  });

  test("buckets are per client: one noisy client does not starve another", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) rateLimiter.take("noisy", t0);
    expect(() => rateLimiter.take("noisy", t0)).toThrow();
    expect(() => rateLimiter.take("quiet", t0)).not.toThrow();
  });

  test("handler wrapper returns a contract-shaped 429 response", async () => {
    const handler = withHandler(async () => ok({ fine: true }));
    const event = () => apiEvent({ sourceIp: "10.0.0.9" });
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await invoke(handler, event())).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await invoke(handler, event());
    expect(limited.json).toMatchObject({ error: "RATE_LIMITED", message: expect.any(String) });
    expect(limited.headers["Retry-After"]).toBeDefined();
  });
});
