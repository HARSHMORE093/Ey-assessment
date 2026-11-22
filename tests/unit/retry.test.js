"use strict";

const { withOptimisticRetry, backoffDelay } = require("../../src/lib/retry");
const { ConcurrencyConflictError, conflict } = require("../../src/lib/errors");

const policy = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 };

describe("exponential backoff with full jitter", () => {
  test("delay is within [0, min(cap, base*2^n))", () => {
    expect(backoffDelay(0, 10, 1000, () => 0.999)).toBe(9);
    expect(backoffDelay(3, 10, 1000, () => 0.5)).toBe(40);
    expect(backoffDelay(20, 10, 1000, () => 0.999)).toBe(999); // capped
    expect(backoffDelay(5, 10, 1000, () => 0)).toBe(0);
  });
});

describe("withOptimisticRetry", () => {
  test("retries on concurrency conflicts and returns the eventual success", async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce(new ConcurrencyConflictError())
      .mockRejectedValueOnce(new ConcurrencyConflictError())
      .mockResolvedValue("ok");
    await expect(withOptimisticRetry(op, policy)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(op.mock.calls.map((c) => c[0])).toEqual([0, 1, 2]); // attempt number passed through
  });

  test("does NOT retry business errors (retrying cannot change the outcome)", async () => {
    const op = jest.fn().mockRejectedValue(conflict("Insufficient funds", "INSUFFICIENT_FUNDS"));
    await expect(withOptimisticRetry(op, policy)).rejects.toMatchObject({ error: "INSUFFICIENT_FUNDS" });
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("bounded attempts (anti-starvation): gives up with a retryable 409", async () => {
    const op = jest.fn().mockRejectedValue(new ConcurrencyConflictError());
    await expect(withOptimisticRetry(op, policy)).rejects.toMatchObject({
      statusCode: 409,
      error: "CONCURRENT_UPDATE",
      headers: { "Retry-After": "1" },
    });
    expect(op).toHaveBeenCalledTimes(4);
  });
});
