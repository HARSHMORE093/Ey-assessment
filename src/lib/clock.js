"use strict";

/**
 * Time access goes through this tiny module so tests can freeze "now"
 * (jest.spyOn(clock, "now")) to exercise banking hours and the daily-limit rollover
 * deterministically.
 */
const clock = {
  now: () => new Date(),
};

/**
 * Wall-clock parts of `date` in an IANA time zone, e.g. America/Toronto.
 * Uses Intl, so daylight-saving transitions are handled by the ICU tz database rather
 * than by hand-written offset arithmetic.
 */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`, // business date, e.g. 2026-11-12
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

module.exports = { clock, zonedParts };
