import { AutomationError, type AutomationUpdatePatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AutomationService from "../../../automation/AutomationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AutomationToolkit } from "./tools.ts";

const unavailableTask = (cause?: unknown) =>
  new AutomationError({
    code: "invalid-destination",
    message: "The current task is unavailable, so its automation settings cannot be read.",
    ...(cause === undefined ? {} : { cause }),
  });

export function makeAutomationToolkitHandlers(
  automations: AutomationService.AutomationServiceShape,
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
) {
  const projectScopedAutomation = Effect.fn("AutomationToolkit.projectScopedAutomation")(function* (
    automationId: Parameters<AutomationService.AutomationServiceShape["get"]>[0],
  ) {
    const invocation = yield* McpInvocationContext.requireAutomationCapability();
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError((cause) => unavailableTask(cause)));
    if (Option.isNone(thread)) return yield* unavailableTask();
    const automation = yield* automations.get(automationId);
    if (automation.projectId !== thread.value.projectId) {
      return yield* new AutomationError({
        code: "not-found",
        message: "Automation not found in this task's project.",
      });
    }
    return { automation, invocation, thread: thread.value } as const;
  });

  const currentTask = Effect.fn("AutomationToolkit.currentTask")(function* () {
    const invocation = yield* McpInvocationContext.requireAutomationCapability();
    const thread = yield* snapshots
      .getThreadShellById(invocation.threadId)
      .pipe(Effect.mapError((cause) => unavailableTask(cause)));
    if (Option.isNone(thread)) return yield* unavailableTask();
    return { invocation, thread: thread.value } as const;
  });

  return {
    automation_list: () =>
      Effect.gen(function* () {
        const { thread } = yield* currentTask();
        return { automations: yield* automations.list({ projectId: thread.projectId }) };
      }),
    automation_get: (input) =>
      projectScopedAutomation(input.automationId).pipe(Effect.map(({ automation }) => automation)),
    automation_create: (input) =>
      Effect.gen(function* () {
        const { invocation, thread } = yield* currentTask();
        return yield* automations.create({
          projectId: thread.projectId,
          name: input.name,
          prompt: input.prompt,
          schedule: input.schedule,
          destination:
            input.destination === "new-task"
              ? { kind: "new-thread" }
              : { kind: "same-thread", threadId: invocation.threadId },
          execution: {
            modelSelection: thread.modelSelection,
            runtimeMode: "full-access",
            approvalPolicy: "never",
            interactionMode: thread.interactionMode,
            responseProfile: "work",
            branch: thread.branch,
            worktreePath: thread.worktreePath,
          },
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        });
      }),
    automation_update: (input) =>
      Effect.gen(function* () {
        const { automation, invocation } = yield* projectScopedAutomation(input.automationId);
        const patch: AutomationUpdatePatch = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
          ...(input.destination === undefined
            ? {}
            : {
                destination:
                  input.destination === "new-task"
                    ? { kind: "new-thread" as const }
                    : { kind: "same-thread" as const, threadId: invocation.threadId },
              }),
        };
        if (Object.keys(patch).length === 0) return automation;
        return yield* automations.update({ automationId: automation.automationId, patch });
      }),
    automation_pause: (input) =>
      Effect.gen(function* () {
        const { automation } = yield* projectScopedAutomation(input.automationId);
        return yield* automations.pause(automation.automationId);
      }),
    automation_resume: (input) =>
      Effect.gen(function* () {
        const { automation } = yield* projectScopedAutomation(input.automationId);
        return yield* automations.resume(automation.automationId);
      }),
    automation_delete: (input) =>
      Effect.gen(function* () {
        const { automation } = yield* projectScopedAutomation(input.automationId);
        yield* automations.remove(automation.automationId);
        return {};
      }),
    automation_run: (input) =>
      Effect.gen(function* () {
        const { automation } = yield* projectScopedAutomation(input.automationId);
        return yield* automations.runNow(automation.automationId);
      }),
    automation_list_runs: (input) =>
      Effect.gen(function* () {
        const { automation } = yield* projectScopedAutomation(input.automationId);
        return {
          runs: yield* automations.listRuns(automation.automationId, input.limit),
        };
      }),
  } satisfies Parameters<typeof AutomationToolkit.toLayer>[0];
}

export const AutomationToolkitHandlersLive = Layer.unwrap(
  Effect.gen(function* () {
    const automations = yield* AutomationService.AutomationService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    return AutomationToolkit.toLayer(makeAutomationToolkitHandlers(automations, snapshots));
  }),
);
