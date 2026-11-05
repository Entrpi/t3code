import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs, formatTimeAgo } from "./orchestrationTiming.ts";

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});

describe("formatTimeAgo", () => {
  it("says how long ago in words, up to years", () => {
    const now = Date.parse("2026-11-06T12:00:00.000Z");
    const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
    const ago = (ms: number) => formatTimeAgo(iso(now - ms), now);
    const minute = 60_000;
    const day = 24 * 60 * minute;
    expect(
      [
        30_000,
        minute,
        45 * minute,
        60 * minute,
        5 * 60 * minute,
        day,
        29 * day,
        31 * day,
        200 * day,
        365 * day,
        800 * day,
      ].map(ago),
    ).toEqual([
      "just now",
      "1 minute ago",
      "45 minutes ago",
      "1 hour ago",
      "5 hours ago",
      "1 day ago",
      "29 days ago",
      "1 month ago",
      "6 months ago",
      "1 year ago",
      "2 years ago",
    ]);
    expect(formatTimeAgo(iso(now + 5 * minute), now)).toBe("just now");
    expect(formatTimeAgo("not a date", now)).toBe("");
  });
});
