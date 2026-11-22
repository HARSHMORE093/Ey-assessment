"use strict";

const { toMinor, toMajor } = require("../../src/lib/money");

describe("money: integer minor units", () => {
  test.each([
    [10, 1000],
    [10.25, 1025],
    [0.1, 10],
    [1.1, 110], // 1.1 * 100 = 110.00000000000001 in float, must still be exact
    [75.5, 7550],
    [999999999.99, 99999999999], // large value where a float-tolerance check would fail
    [0, 0],
  ])("toMinor(%p) = %p", (major, minor) => {
    expect(toMinor(major)).toBe(minor);
  });

  test.each([10.005, 0.001, 1e-7, NaN, Infinity, "10", null, undefined])("rejects %p", (bad) => {
    expect(toMinor(bad)).toBeNull();
  });

  test("avoids floating point drift: 0.1 + 0.2 handled as 10 + 20 cents", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the classic bug
    expect(toMajor(toMinor(0.1) + toMinor(0.2))).toBe(0.3);
  });

  test("round trip minor → major → minor is loss-free", () => {
    for (const minor of [1, 7, 99, 101, 12345, 100000000001]) {
      expect(toMinor(toMajor(minor))).toBe(minor);
    }
  });
});
