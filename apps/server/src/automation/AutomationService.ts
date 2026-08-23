// @effect-diagnostics globalDate:off -- Schedule calculation uses the Intl Date boundary.
import * as NodeCrypto from "node:crypto";

import {
  AUTOMATION_RUN_HISTORY_LIMIT,
  AutomationError,
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ThreadId,
  type Automation,
  type AutomationCreateInput,
  type AutomationListInput,
  type AutomationRemoteDispatchInput,
  type AutomationRemoteDispatchResult,
  type AutomationRun,
  type AutomationRunTrigger,
  type AutomationRunStatusInput,
  type AutomationUpdateInput,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as AutomationStore from "./AutomationStore.ts";
import {
  firstAutomationOccurrence,
  nextAutomationOccurrence,
  ScheduleValidationError,
  validateAutomationSchedule,
} from "./Schedule.ts";

const notFound = () => new AutomationError({ code: "not-found", message: "Automation not found." });

const mapScheduleError = (cause: unknown) =>
  new AutomationError({
    code: "invalid-schedule",
    message: cause instanceof Error ? cause.message : "The schedule is invalid.",
    cause,
  });

const mapDispatchError = (cause: unknown) =>
  new AutomationError({
    code: "dispatch-failed",
    message: cause instanceof Error ? cause.message : "The automation prompt could not start.",
    cause,
  });
const isAutomationError = Schema.is(AutomationError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function automationRunId(
  automationId: AutomationId,
  occurrenceKey: string,
): AutomationRunId {
  const digest = NodeCrypto.createHash("sha256")
    .update(automationId)
    .update("\0")
    .update(occurrenceKey)
    .digest("hex")
    .slice(0, 32);
  return AutomationRunId.make(`automation-run-${digest}`);
}

function runThreadId(runId: AutomationRunId): ThreadId {
  return ThreadId.make(`automation-thread:${runId}`);
}

function runCommandId(runId: AutomationRunId, operation: string): CommandId {
  return CommandId.make(`automation:${runId}:${operation}`);
}

function runMessageId(runId: AutomationRunId): MessageId {
  return MessageId.make(`automation-message:${runId}`);
}

function assertUnattendedExecution(automation: Pick<Automation, "execution">): void {
  if (
    automation.execution.runtimeMode !== "full-access" ||
    automation.execution.approvalPolicy !== "never"
  ) {
    throw new AutomationError({
      code: "invalid-execution",
      message: "Automations must use Full access and Never ask.",
    });
  }
}

export function unattendedRunFailureReason(input: {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}): string | null {
  if (input.hasPendingApprovals) {
    return "The provider requested approval during an unattended automation run.";
  }
  if (input.hasPendingUserInput) {
    return "The provider requested user input during an unattended automation run.";
  }
  return null;
}

export function isAutomationThreadIdle(
  thread: Pick<
    OrchestrationThreadShell,
    "latestTurn" | "session" | "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness"
  >,
): boolean {
  if (thread.latestTurn?.state === "running") return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  return (thread.backgroundLiveness ?? null) === null;
}

export function doesAutomationRunOwnLatestTurn(
  runStartedAt: string,
  latestTurnRequestedAt: string,
): boolean {
  return runStartedAt === latestTurnRequestedAt;
}

export function doesAutomationRunCompleteOneTimeSchedule(
  scheduleKind: Automation["schedule"]["kind"],
  trigger: AutomationRunTrigger,
): boolean {
  return scheduleKind === "once" && trigger !== "manual";
}

export interface AutomationServiceShape {
  readonly list: (
    input: AutomationListInput,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationError>;
  readonly get: (automationId: AutomationId) => Effect.Effect<Automation, AutomationError>;
  readonly create: (input: AutomationCreateInput) => Effect.Effect<Automation, AutomationError>;
  readonly update: (input: AutomationUpdateInput) => Effect.Effect<Automation, AutomationError>;
  readonly remove: (automationId: AutomationId) => Effect.Effect<void, AutomationError>;
  readonly pause: (automationId: AutomationId) => Effect.Effect<Automation, AutomationError>;
  readonly resume: (automationId: AutomationId) => Effect.Effect<Automation, AutomationError>;
  readonly runNow: (automationId: AutomationId) => Effect.Effect<AutomationRun, AutomationError>;
  readonly listRuns: (
    automationId: AutomationId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationError>;
  readonly dispatchRemote: (
    automationId: AutomationId,
    input: AutomationRemoteDispatchInput,
  ) => Effect.Effect<AutomationRemoteDispatchResult, AutomationError>;
  readonly getRunStatus: (
    input: AutomationRunStatusInput,
  ) => Effect.Effect<AutomationRun, AutomationError>;
  readonly tick: (at?: string) => Effect.Effect<void, AutomationError>;
}

export class AutomationService extends Context.Service<AutomationService, AutomationServiceShape>()(
  "t3/automation/AutomationService",
) {}

export const make = Effect.gen(function* () {
  const store = yield* AutomationStore.AutomationStore;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const get = Effect.fn("AutomationService.get")(function* (automationId: AutomationId) {
    const automation = yield* store.get(automationId);
    return yield* Option.match(automation, {
      onNone: () => notFound(),
      onSome: Effect.succeed,
    });
  });

  const validateDestination = Effect.fn("AutomationService.validateDestination")(function* (
    automation: Pick<Automation, "projectId" | "destination">,
  ) {
    if (automation.destination.kind === "new-thread") return;
    const thread = yield* snapshots.getThreadShellById(automation.destination.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new AutomationError({
            code: "invalid-destination",
            message: "The destination task could not be read.",
            cause,
          }),
      ),
    );
    if (Option.isNone(thread) || thread.value.projectId !== automation.projectId) {
      return yield* new AutomationError({
        code: "invalid-destination",
        message: "The destination task must belong to this project.",
      });
    }
  });

  const validateDefinition = Effect.fn("AutomationService.validateDefinition")(function* (
    automation: Automation,
  ) {
    yield* Effect.try({
      try: () => {
        validateAutomationSchedule(automation.schedule);
        assertUnattendedExecution(automation);
      },
      catch: (cause) =>
        cause instanceof ScheduleValidationError
          ? mapScheduleError(cause)
          : isAutomationError(cause)
            ? cause
            : mapDispatchError(cause),
    });
    yield* validateDestination(automation);
  });

  const list: AutomationServiceShape["list"] = (input) => store.list(input.projectId);

  const create = Effect.fn("AutomationService.create")(function* (input: AutomationCreateInput) {
    const timestamp = yield* nowIso;
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.mapError(mapDispatchError));
    const nextRunAt =
      input.enabled === false
        ? null
        : yield* Effect.try({
            try: () => firstAutomationOccurrence(input.schedule, timestamp),
            catch: mapScheduleError,
          });
    const automation: Automation = {
      automationId: AutomationId.make(uuid),
      projectId: input.projectId,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      destination: input.destination,
      execution: input.execution,
      status: input.enabled === false ? "paused" : "active",
      nextRunAt,
      consecutiveFailures: 0,
      pausedReason: input.enabled === false ? "user" : null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* validateDefinition(automation);
    yield* store.save(automation);
    return automation;
  });

  const update = Effect.fn("AutomationService.update")(function* (input: AutomationUpdateInput) {
    const current = yield* get(input.automationId);
    const timestamp = yield* nowIso;
    let nextRunAt = current.nextRunAt;
    if (input.patch.schedule !== undefined && current.status === "active") {
      nextRunAt = yield* Effect.try({
        try: () => firstAutomationOccurrence(input.patch.schedule!, timestamp),
        catch: mapScheduleError,
      });
    }
    const automation: Automation = {
      ...current,
      ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
      ...(input.patch.prompt === undefined ? {} : { prompt: input.patch.prompt }),
      ...(input.patch.schedule === undefined ? {} : { schedule: input.patch.schedule }),
      ...(input.patch.destination === undefined ? {} : { destination: input.patch.destination }),
      ...(input.patch.execution === undefined ? {} : { execution: input.patch.execution }),
      nextRunAt,
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    yield* validateDefinition(automation);
    yield* store.save(automation);
    return automation;
  });

  const remove: AutomationServiceShape["remove"] = (automationId) =>
    nowIso.pipe(Effect.flatMap((timestamp) => store.remove(automationId, timestamp)));

  const pause = Effect.fn("AutomationService.pause")(function* (automationId: AutomationId) {
    const current = yield* get(automationId);
    if (current.status === "paused" && current.pausedReason === "user") return current;
    const timestamp = yield* nowIso;
    const automation: Automation = {
      ...current,
      status: "paused",
      pausedReason: "user",
      nextRunAt: null,
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    yield* store.save(automation);
    return automation;
  });

  const resume = Effect.fn("AutomationService.resume")(function* (automationId: AutomationId) {
    const current = yield* get(automationId);
    if (current.schedule.kind === "once" && current.pausedReason === "one-time-completed") {
      return yield* new AutomationError({
        code: "conflict",
        message: "A completed one-time automation cannot be resumed.",
      });
    }
    const timestamp = yield* nowIso;
    const nextRunAt = yield* Effect.try({
      try: () => firstAutomationOccurrence(current.schedule, timestamp),
      catch: mapScheduleError,
    });
    const automation: Automation = {
      ...current,
      status: "active",
      pausedReason: null,
      nextRunAt,
      consecutiveFailures: 0,
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    yield* store.save(automation);
    return automation;
  });

  const advanceSchedule = Effect.fn("AutomationService.advanceSchedule")(function* (
    automation: Automation,
    timestamp: string,
  ) {
    const nextRunAt = yield* Effect.try({
      try: () => nextAutomationOccurrence(automation.schedule, timestamp),
      catch: mapScheduleError,
    });
    const advanced: Automation = {
      ...automation,
      nextRunAt,
      revision: automation.revision + 1,
      updatedAt: timestamp,
    };
    yield* store.saveOperationalState(advanced);
    return advanced;
  });

  const enqueueOccurrence = Effect.fn("AutomationService.enqueueOccurrence")(function* (input: {
    readonly automation: Automation;
    readonly occurrenceKey: string;
    readonly scheduledFor: string;
    readonly trigger: "schedule" | "manual" | "remote";
    readonly timestamp: string;
    readonly advance: boolean;
    readonly failureReason?: string;
  }) {
    const result = yield* store.insertRun({
      runId: automationRunId(input.automation.automationId, input.occurrenceKey),
      automationId: input.automation.automationId,
      occurrenceKey: input.occurrenceKey,
      scheduledFor: input.scheduledFor,
      trigger: input.trigger,
      createdAt: input.timestamp,
      ...(input.failureReason === undefined
        ? {}
        : { initialStatus: "failed" as const, failureReason: input.failureReason }),
    });
    if (!result.deduplicated && input.advance) {
      yield* advanceSchedule(input.automation, input.timestamp);
    }
    return result;
  });

  const runNow = Effect.fn("AutomationService.runNow")(function* (automationId: AutomationId) {
    const automation = yield* get(automationId);
    const timestamp = yield* nowIso;
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.mapError(mapDispatchError));
    const result = yield* enqueueOccurrence({
      automation,
      occurrenceKey: `manual:${uuid}`,
      scheduledFor: timestamp,
      trigger: "manual",
      timestamp,
      advance: false,
    });
    return result.run;
  });

  const dispatchRemote = Effect.fn("AutomationService.dispatchRemote")(function* (
    automationId: AutomationId,
    input: AutomationRemoteDispatchInput,
  ) {
    const duplicate = yield* store.getRunByOccurrence(automationId, input.occurrenceKey);
    if (Option.isSome(duplicate)) {
      return {
        runId: duplicate.value.runId,
        status: duplicate.value.status,
        deduplicated: true,
      } satisfies AutomationRemoteDispatchResult;
    }
    const automation = yield* get(automationId);
    if (automation.status !== "active" || automation.revision !== input.registrationRevision) {
      return yield* new AutomationError({
        code: "conflict",
        message: "The coordinator registration is stale or paused.",
      });
    }
    const timestamp = yield* nowIso;
    const result = yield* enqueueOccurrence({
      automation,
      occurrenceKey: input.occurrenceKey,
      scheduledFor: input.scheduledFor,
      trigger: "remote",
      timestamp,
      advance: true,
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    });
    if (!result.deduplicated && input.failureReason !== undefined) {
      yield* finishRun(result.run, "failed", input.failureReason, timestamp);
    }
    const run = yield* store.getRun(result.run.runId);
    const persisted = Option.getOrElse(run, () => result.run);
    return {
      runId: persisted.runId,
      status: persisted.status,
      deduplicated: result.deduplicated,
    } satisfies AutomationRemoteDispatchResult;
  });

  const listRuns: AutomationServiceShape["listRuns"] = (
    automationId,
    limit = AUTOMATION_RUN_HISTORY_LIMIT,
  ) => store.listRuns(automationId, limit);

  const getRunStatus = Effect.fn("AutomationService.getRunStatus")(function* (
    input: AutomationRunStatusInput,
  ) {
    const run = yield* store.getRun(input.runId);
    if (Option.isNone(run) || run.value.automationId !== input.automationId) {
      return yield* notFound();
    }
    return run.value;
  });

  const finishRun = Effect.fn("AutomationService.finishRun")(function* (
    run: AutomationRun,
    status: "succeeded" | "failed",
    failureReason: string | null,
    timestamp: string,
  ) {
    const automation = yield* get(run.automationId);
    const boundedFailureReason = failureReason?.slice(0, 4_000) ?? null;
    const consecutiveFailures = status === "succeeded" ? 0 : automation.consecutiveFailures + 1;
    const oneTimeCompleted = doesAutomationRunCompleteOneTimeSchedule(
      automation.schedule.kind,
      run.trigger,
    );
    const tooManyFailures = consecutiveFailures >= 3;
    const updatedAutomation: Automation = {
      ...automation,
      consecutiveFailures,
      status: oneTimeCompleted || tooManyFailures ? "paused" : automation.status,
      pausedReason: oneTimeCompleted
        ? "one-time-completed"
        : tooManyFailures
          ? "three-consecutive-failures"
          : automation.pausedReason,
      nextRunAt: oneTimeCompleted || tooManyFailures ? null : automation.nextRunAt,
      revision: automation.revision + 1,
      updatedAt: timestamp,
    };
    const completedRun: AutomationRun = {
      ...run,
      status,
      finishedAt: timestamp,
      failureReason: boundedFailureReason,
    };
    yield* store.finishRun(completedRun, updatedAutomation);
  });

  const launchRun = Effect.fn("AutomationService.launchRun")(function* (
    run: AutomationRun,
    automation: Automation,
    timestamp: string,
  ) {
    let threadId: ThreadId;
    if (automation.destination.kind === "same-thread") {
      threadId = automation.destination.threadId;
      const thread = yield* snapshots
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(mapDispatchError));
      if (Option.isNone(thread)) {
        yield* finishRun(run, "failed", "The destination task no longer exists.", timestamp);
        return;
      }
      if (!isAutomationThreadIdle(thread.value)) {
        if (run.status !== "waiting-for-thread") {
          yield* store.updateRun({ ...run, status: "waiting-for-thread" });
        }
        return;
      }
    } else {
      threadId = runThreadId(run.runId);
      yield* orchestration
        .dispatch({
          type: "thread.create",
          commandId: runCommandId(run.runId, "create-thread"),
          threadId,
          projectId: automation.projectId,
          title: automation.name,
          modelSelection: automation.execution.modelSelection,
          runtimeMode: "full-access",
          interactionMode: automation.execution.interactionMode,
          branch: automation.execution.branch,
          worktreePath: automation.execution.worktreePath,
          createdAt: timestamp,
        })
        .pipe(Effect.mapError(mapDispatchError));
    }

    yield* orchestration
      .dispatch({
        type: "thread.turn.start",
        commandId: runCommandId(run.runId, "start-turn"),
        threadId,
        message: {
          messageId: runMessageId(run.runId),
          role: "user",
          text: automation.prompt,
          attachments: [],
        },
        modelSelection: automation.execution.modelSelection,
        runtimeMode: "full-access",
        interactionMode: automation.execution.interactionMode,
        responseProfile: automation.execution.responseProfile,
        createdAt: timestamp,
      })
      .pipe(Effect.mapError(mapDispatchError));

    yield* store.updateRun({
      ...run,
      status: "running",
      threadId,
      startedAt: timestamp,
    });
  });

  const monitorRun = Effect.fn("AutomationService.monitorRun")(function* (
    run: AutomationRun,
    timestamp: string,
  ) {
    if (run.threadId === null || run.startedAt === null) return;
    const thread = yield* snapshots
      .getThreadShellById(run.threadId)
      .pipe(Effect.mapError(mapDispatchError));
    if (Option.isNone(thread)) {
      yield* finishRun(
        run,
        "failed",
        "The automation task disappeared while it was running.",
        timestamp,
      );
      return;
    }
    const failureReason = unattendedRunFailureReason(thread.value);
    if (failureReason !== null) {
      if (thread.value.latestTurn?.state === "running") {
        yield* orchestration
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: runCommandId(run.runId, "reject-unattended-request"),
            threadId: run.threadId,
            turnId: thread.value.latestTurn.turnId,
            createdAt: timestamp,
          })
          .pipe(Effect.mapError(mapDispatchError));
      }
      yield* finishRun(run, "failed", failureReason, timestamp);
      return;
    }
    const latestTurn = thread.value.latestTurn;
    if (latestTurn === null || latestTurn.state === "running") return;
    if (!doesAutomationRunOwnLatestTurn(run.startedAt, latestTurn.requestedAt)) {
      if (latestTurn.requestedAt > run.startedAt) {
        yield* finishRun(
          run,
          "failed",
          "The automation run could no longer be matched to its task turn.",
          timestamp,
        );
      }
      return;
    }
    if (latestTurn.state === "completed") {
      yield* finishRun(run, "succeeded", null, timestamp);
    } else {
      yield* finishRun(
        run,
        "failed",
        `The automation turn ended with status ${latestTurn.state}.`,
        timestamp,
      );
    }
  });

  const scheduleDue = Effect.fn("AutomationService.scheduleDue")(function* (timestamp: string) {
    const due = yield* store.listDue(timestamp);
    for (const automation of due) {
      if (automation.nextRunAt === null) continue;
      yield* enqueueOccurrence({
        automation,
        occurrenceKey: `${automation.automationId}:${automation.nextRunAt}`,
        scheduledFor: automation.nextRunAt,
        trigger: "schedule",
        timestamp,
        advance: true,
      }).pipe(
        Effect.catchTag("AutomationError", (error) =>
          error.code === "conflict" ? Effect.void : Effect.fail(error),
        ),
      );
    }
  });

  const tick = Effect.fn("AutomationService.tick")(function* (at?: string) {
    const timestamp = at ?? (yield* nowIso);
    yield* scheduleDue(timestamp);
    const runs = yield* store.listRunnable();
    for (const run of runs) {
      if (run.status === "running") {
        yield* monitorRun(run, timestamp);
        continue;
      }
      const automation = yield* get(run.automationId);
      yield* launchRun(run, automation, timestamp).pipe(
        Effect.catchIf(isAutomationError, (error) =>
          finishRun(run, "failed", error.message, timestamp),
        ),
      );
    }
  });

  return AutomationService.of({
    list,
    get,
    create,
    update,
    remove,
    pause,
    resume,
    runNow,
    listRuns,
    dispatchRemote,
    getRunStatus,
    tick,
  });
});

export const layer = Layer.effect(AutomationService, make);
