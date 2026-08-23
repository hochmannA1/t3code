import { describe, expect, it } from "@effect/vitest";

import {
  automationRunId,
  doesAutomationRunCompleteOneTimeSchedule,
  doesAutomationRunOwnLatestTurn,
  isAutomationThreadIdle,
  shouldScheduleAutomationsLocally,
  unattendedRunFailureReason,
} from "./AutomationService.ts";

const idleThread = {
  latestTurn: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
} as const;

describe("automation unattended runs", () => {
  it("uses a short deterministic run id that is safe in the status URL", () => {
    const automationId = "automation-1" as never;
    const occurrenceKey = `scheduled:${"x".repeat(500)}`;
    const runId = automationRunId(automationId, occurrenceKey);

    expect(runId).toBe(automationRunId(automationId, occurrenceKey));
    expect(runId).not.toBe(automationRunId(automationId, `${occurrenceKey}-other`));
    expect(runId.length).toBeLessThan(100);
    expect(runId).toMatch(/^automation-run-[a-f0-9]{32}$/);
  });

  it("fails immediately when a provider asks for approval", () => {
    expect(
      unattendedRunFailureReason({
        hasPendingApprovals: true,
        hasPendingUserInput: false,
      }),
    ).toContain("requested approval");
  });

  it("fails immediately when a provider asks the user a question", () => {
    expect(
      unattendedRunFailureReason({
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toContain("requested user input");
  });

  it("starts a same-task run only after every activity blocker clears", () => {
    expect(isAutomationThreadIdle(idleThread)).toBe(true);
    expect(
      isAutomationThreadIdle({
        ...idleThread,
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
          requestedAt: "2026-08-23T10:00:00.000Z",
          startedAt: "2026-08-23T10:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ).toBe(false);
    expect(
      isAutomationThreadIdle({
        ...idleThread,
        session: {
          threadId: "thread-1" as never,
          status: "starting",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-23T10:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(isAutomationThreadIdle({ ...idleThread, hasPendingApprovals: true })).toBe(false);
    expect(isAutomationThreadIdle({ ...idleThread, hasPendingUserInput: true })).toBe(false);
    expect(isAutomationThreadIdle({ ...idleThread, backgroundLiveness: "working" })).toBe(false);
  });

  it("correlates completion only to the exact turn started by the automation", () => {
    expect(
      doesAutomationRunOwnLatestTurn("2026-08-23T10:00:00.000Z", "2026-08-23T10:00:00.000Z"),
    ).toBe(true);
    expect(
      doesAutomationRunOwnLatestTurn("2026-08-23T10:00:00.000Z", "2026-08-23T10:01:00.000Z"),
    ).toBe(false);
  });

  it("keeps a one-time schedule after a manual run", () => {
    expect(doesAutomationRunCompleteOneTimeSchedule("once", "manual")).toBe(false);
    expect(doesAutomationRunCompleteOneTimeSchedule("once", "schedule")).toBe(true);
    expect(doesAutomationRunCompleteOneTimeSchedule("once", "remote")).toBe(true);
    expect(doesAutomationRunCompleteOneTimeSchedule("cron", "manual")).toBe(false);
  });

  it("leaves scheduled occurrences to the remote coordinator when configured", () => {
    expect(shouldScheduleAutomationsLocally(undefined)).toBe(true);
    expect(shouldScheduleAutomationsLocally("")).toBe(true);
    expect(shouldScheduleAutomationsLocally("   ")).toBe(true);
    expect(shouldScheduleAutomationsLocally("https://coordinator.example/internal/tools")).toBe(
      false,
    );
  });
});
