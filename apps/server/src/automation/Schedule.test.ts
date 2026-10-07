// @effect-diagnostics globalDate:off -- Tests exercise the Date-based cron boundary.
import { describe, expect, it } from "@effect/vitest";

import {
  firstAutomationOccurrence,
  nextAutomationOccurrence,
  ScheduleValidationError,
} from "./Schedule.ts";

describe("automation schedules", () => {
  it("coalesces an interval that started in the past to its latest occurrence", () => {
    expect(
      firstAutomationOccurrence(
        { kind: "interval", everyMinutes: 15, startsAt: "2026-08-23T10:00:00.000Z" },
        "2026-08-23T10:44:00.000Z",
      ),
    ).toBe("2026-08-23T10:30:00.000Z");
  });

  it("calculates the next interval strictly after the supplied time", () => {
    expect(
      nextAutomationOccurrence(
        { kind: "interval", everyMinutes: 15, startsAt: "2026-08-23T10:00:00.000Z" },
        "2026-08-23T10:30:00.000Z",
      ),
    ).toBe("2026-08-23T10:45:00.000Z");
  });

  it("evaluates cron in its IANA timezone", () => {
    expect(
      nextAutomationOccurrence(
        { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Vienna" },
        "2026-08-21T08:00:00.000Z",
      ),
    ).toBe("2026-08-24T07:00:00.000Z");
  });

  it("rejects programming-style cron extensions and unknown timezones", () => {
    expect(() =>
      nextAutomationOccurrence(
        { kind: "cron", expression: "@daily", timezone: "Europe/Vienna" },
        "2026-08-23T10:00:00.000Z",
      ),
    ).toThrow(ScheduleValidationError);
    expect(() =>
      nextAutomationOccurrence(
        { kind: "cron", expression: "0 9 * * *", timezone: "Moon/SeaOfTranquility" },
        "2026-08-23T10:00:00.000Z",
      ),
    ).toThrow("Unknown timezone");
  });
});
