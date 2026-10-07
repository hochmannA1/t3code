import type { Automation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationCanResume,
  automationScheduleDraft,
  automationScheduleLabel,
  buildAutomationSchedule,
  filterAutomations,
} from "./automationPresentation";

describe("automation schedule presentation", () => {
  it("turns friendly weekday controls into a cron schedule", () => {
    const result = buildAutomationSchedule({
      choice: "weekdays",
      onceAt: "",
      everyValue: "",
      everyUnit: "hours",
      startsAt: "",
      time: "08:30",
      weekday: "1",
      cronExpression: "",
      timezone: "Europe/Vienna",
    });

    expect(result).toEqual({
      schedule: {
        kind: "cron",
        expression: "30 8 * * 1-5",
        timezone: "Europe/Vienna",
      },
      error: null,
    });
  });

  it("recognises friendly presets when editing", () => {
    expect(
      automationScheduleDraft({
        kind: "cron",
        expression: "15 9 * * 1-5",
        timezone: "Europe/Vienna",
      }),
    ).toMatchObject({ choice: "weekdays", time: "09:15", timezone: "Europe/Vienna" });
  });

  it("keeps unfamiliar cron expressions behind custom schedule", () => {
    expect(
      automationScheduleDraft({
        kind: "cron",
        expression: "0 9 1 * *",
        timezone: "UTC",
      }),
    ).toMatchObject({ choice: "custom", cronExpression: "0 9 1 * *", timezone: "UTC" });
  });

  it("writes interval labels without scheduler jargon", () => {
    expect(
      automationScheduleLabel({
        kind: "interval",
        everyMinutes: 120,
        startsAt: "2026-08-23T10:00:00.000Z",
      }),
    ).toBe("Every 2 hours");
  });
});

describe("automation list presentation", () => {
  const automation = {
    automationId: "automation-1",
    projectId: "project-1",
    name: "Morning status",
    prompt: "Summarize overnight alerts",
    status: "active",
  } as unknown as Automation;

  it("filters by status and searches project names", () => {
    const projectNames = new Map([["project-1", "Remote Agent Hub"]]);
    expect(filterAutomations([automation], "active", "agent hub", projectNames)).toEqual([
      automation,
    ]);
    expect(filterAutomations([automation], "paused", "", projectNames)).toEqual([]);
  });

  it("does not resume completed one-time automations", () => {
    expect(
      automationCanResume({
        ...automation,
        status: "paused",
        pausedReason: "one-time-completed",
      }),
    ).toBe(false);
  });
});
