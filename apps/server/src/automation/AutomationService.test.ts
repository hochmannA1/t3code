import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AutomationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Automation,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AutomationStore from "./AutomationStore.ts";
import * as AutomationServiceModule from "./AutomationService.ts";
import {
  automationRunId,
  doesAutomationRunCompleteOneTimeSchedule,
  doesAutomationRunOwnLatestTurn,
  isAutomationThreadIdle,
  shouldScheduleAutomationsLocally,
  unattendedRunFailureReason,
} from "./AutomationService.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const projectId = ProjectId.make("automation-test-project");
const threadId = ThreadId.make("automation-test-thread");
const automationId = AutomationId.make("automation-test");

function makeAutomation(): Automation {
  return {
    automationId,
    projectId,
    name: "Same-thread run",
    prompt: "Prepare the scheduled update.",
    schedule: { kind: "interval", everyMinutes: 60, startsAt: NOW },
    destination: { kind: "same-thread", threadId },
    execution: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      runtimeMode: "full-access",
      approvalPolicy: "never",
      interactionMode: "plan",
      responseProfile: "code",
      branch: null,
      worktreePath: null,
    },
    status: "active",
    nextRunAt: NOW,
    consecutiveFailures: 0,
    pausedReason: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    id: threadId,
    projectId,
    title: "Same-thread destination",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("automation unattended runs", () => {
  it("uses a short deterministic run id that is safe in the status URL", () => {
    const id = "automation-1" as never;
    const occurrenceKey = `scheduled:${"x".repeat(500)}`;
    const runId = automationRunId(id, occurrenceKey);

    expect(runId).toBe(automationRunId(id, occurrenceKey));
    expect(runId).not.toBe(automationRunId(id, `${occurrenceKey}-other`));
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

  it("waits on V2 active runs, runtime requests, and background work", () => {
    const idle = {
      activeRunId: null,
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
      status: "idle",
    } as const;
    expect(isAutomationThreadIdle(idle as never)).toBe(true);
    expect(isAutomationThreadIdle({ ...idle, activeRunId: "run-1" } as never)).toBe(false);
    expect(isAutomationThreadIdle({ ...idle, status: "running" } as never)).toBe(false);
    expect(
      isAutomationThreadIdle({ ...idle, pendingRuntimeRequest: { id: "request-1" } } as never),
    ).toBe(false);
    expect(
      isAutomationThreadIdle({ ...idle, pendingBackgroundTasks: [{ id: "task-1" }] } as never),
    ).toBe(false);
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

  const events: Array<{ readonly type: string; readonly commandId: string }> = [];
  let currentThread = makeThread();
  const layerStore = AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const layerThreadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getProjectThread: () => Effect.succeed(undefined as never),
    getThreadShell: () => Effect.succeed(currentThread),
    dispatch: (command) =>
      Effect.sync(() => {
        events.push({ type: command.type, commandId: command.commandId });
        if (command.type === "thread.runtime-mode.set") {
          currentThread = { ...currentThread, runtimeMode: command.runtimeMode };
        } else if (command.type === "thread.interaction-mode.set") {
          currentThread = { ...currentThread, interactionMode: command.interactionMode };
        }
      }).pipe(Effect.as(undefined as never)),
    sendToThread: (input) =>
      Effect.sync(() => {
        expect(currentThread.runtimeMode).toBe("full-access");
        expect(currentThread.interactionMode).toBe("plan");
        expect(input.mode).toBe("queue");
        expect(input.responseProfile).toBe("code");
        events.push({ type: "sendToThread", commandId: input.commandId });
      }).pipe(Effect.as(undefined as never)),
  });
  const layerService = AutomationServiceModule.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerStore,
        NodeCrypto.layer,
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        layerThreadManagement,
      ),
    ),
  );

  it.layer(layerService)("AutomationService", (it) => {
    it.effect("applies same-thread policy before sending and persists queued run correlation", () =>
      Effect.gen(function* () {
        events.length = 0;
        currentThread = makeThread();
        const service = yield* AutomationServiceModule.AutomationService;
        const store = yield* AutomationStore.AutomationStore;
        const automation = makeAutomation();
        yield* store.save(automation);

        const queued = yield* service.runNow(automation.automationId);
        expect(queued.status).toBe("pending");
        expect(Option.getOrThrow(yield* store.getRun(queued.runId)).status).toBe("pending");

        yield* service.tick(NOW, { scheduleLocally: false });

        const persisted = yield* service.getRunStatus({
          automationId: automation.automationId,
          runId: queued.runId,
        });
        expect(persisted).toMatchObject({
          runId: queued.runId,
          status: "running",
          threadId,
          startedAt: NOW,
        });
        expect(events.map(({ type }) => type)).toEqual([
          "thread.runtime-mode.set",
          "thread.interaction-mode.set",
          "sendToThread",
        ]);
        expect(events.every(({ commandId }) => commandId.includes(queued.runId))).toBe(true);
      }),
    );
  });
});
