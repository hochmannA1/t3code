import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AutomationId,
  AutomationRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ResponseProfile,
  RuntimeMode,
} from "./orchestration.ts";

export const AUTOMATION_RUN_HISTORY_LIMIT = 100;

export const AutomationOnceSchedule = Schema.Struct({
  kind: Schema.Literal("once"),
  at: IsoDateTime,
});

export const AutomationIntervalSchedule = Schema.Struct({
  kind: Schema.Literal("interval"),
  everyMinutes: PositiveInt,
  startsAt: IsoDateTime,
});

export const AutomationCronSchedule = Schema.Struct({
  kind: Schema.Literal("cron"),
  expression: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  timezone: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});

export const AutomationSchedule = Schema.Union([
  AutomationOnceSchedule,
  AutomationIntervalSchedule,
  AutomationCronSchedule,
]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationDestination = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("same-thread"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("new-thread") }),
]);
export type AutomationDestination = typeof AutomationDestination.Type;

export const AutomationExecution = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed("full-access"))),
  approvalPolicy: ProviderApprovalPolicy.pipe(Schema.withDecodingDefault(Effect.succeed("never"))),
  interactionMode: ProviderInteractionMode,
  responseProfile: ResponseProfile,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type AutomationExecution = typeof AutomationExecution.Type;

export const AutomationStatus = Schema.Literals(["active", "paused"]);
export type AutomationStatus = typeof AutomationStatus.Type;

export const AutomationPausedReason = Schema.Literals([
  "user",
  "three-consecutive-failures",
  "one-time-completed",
]);
export type AutomationPausedReason = typeof AutomationPausedReason.Type;

export const Automation = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  schedule: AutomationSchedule,
  destination: AutomationDestination,
  execution: AutomationExecution,
  status: AutomationStatus,
  nextRunAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: NonNegativeInt,
  pausedReason: Schema.NullOr(AutomationPausedReason),
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Automation = typeof Automation.Type;

export const AutomationRunStatus = Schema.Literals([
  "pending",
  "waiting-for-thread",
  "running",
  "succeeded",
  "failed",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRunTrigger = Schema.Literals(["schedule", "manual", "remote"]);
export type AutomationRunTrigger = typeof AutomationRunTrigger.Type;

export const AutomationRun = Schema.Struct({
  runId: AutomationRunId,
  automationId: AutomationId,
  occurrenceKey: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  scheduledFor: IsoDateTime,
  status: AutomationRunStatus,
  trigger: AutomationRunTrigger,
  threadId: Schema.NullOr(ThreadId),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  failureReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  createdAt: IsoDateTime,
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationCreateInput = Schema.Struct({
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  schedule: AutomationSchedule,
  destination: AutomationDestination,
  execution: AutomationExecution,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdatePatch = Schema.Struct({
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  prompt: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120_000))),
  schedule: Schema.optionalKey(AutomationSchedule),
  destination: Schema.optionalKey(AutomationDestination),
  execution: Schema.optionalKey(AutomationExecution),
});
export type AutomationUpdatePatch = typeof AutomationUpdatePatch.Type;

export const AutomationUpdateInput = Schema.Struct({
  automationId: AutomationId,
  patch: AutomationUpdatePatch,
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({ automationId: AutomationId });
export type AutomationIdInput = typeof AutomationIdInput.Type;

export const AutomationListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type AutomationListInput = typeof AutomationListInput.Type;

export const AutomationListResult = Schema.Struct({ automations: Schema.Array(Automation) });
export type AutomationListResult = typeof AutomationListResult.Type;

export const AutomationListRunsInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AUTOMATION_RUN_HISTORY_LIMIT })),
  ),
});
export type AutomationListRunsInput = typeof AutomationListRunsInput.Type;

export const AutomationListRunsResult = Schema.Struct({ runs: Schema.Array(AutomationRun) });
export type AutomationListRunsResult = typeof AutomationListRunsResult.Type;

export const AutomationDeleteResult = Schema.Struct({});
export type AutomationDeleteResult = typeof AutomationDeleteResult.Type;

export const AutomationErrorCode = Schema.Literals([
  "not-found",
  "invalid-schedule",
  "invalid-destination",
  "invalid-execution",
  "conflict",
  "dispatch-failed",
  "persistence-failed",
  "access-disabled",
]);
export type AutomationErrorCode = typeof AutomationErrorCode.Type;

export class AutomationError extends Schema.TaggedErrorClass<AutomationError>()("AutomationError", {
  code: AutomationErrorCode,
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const AutomationCapabilities = Schema.Struct({
  schedules: Schema.Tuple([
    Schema.Literal("once"),
    Schema.Literal("interval"),
    Schema.Literal("cron"),
  ]),
  destinations: Schema.Tuple([Schema.Literal("same-thread"), Schema.Literal("new-thread")]),
  remoteScheduling: Schema.Boolean,
});
export type AutomationCapabilities = typeof AutomationCapabilities.Type;

export const AutomationMirrorRegistration = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  revision: PositiveInt,
  enabled: Schema.Boolean,
  schedule: AutomationSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
});
export type AutomationMirrorRegistration = typeof AutomationMirrorRegistration.Type;

export const AutomationRemoteDispatchInput = Schema.Struct({
  occurrenceKey: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  scheduledFor: IsoDateTime,
  registrationRevision: PositiveInt,
  failureReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type AutomationRemoteDispatchInput = typeof AutomationRemoteDispatchInput.Type;

export const AutomationRemoteDispatchResult = Schema.Struct({
  runId: AutomationRunId,
  status: AutomationRunStatus,
  deduplicated: Schema.Boolean,
});
export type AutomationRemoteDispatchResult = typeof AutomationRemoteDispatchResult.Type;

export const AutomationRunStatusInput = Schema.Struct({
  automationId: AutomationId,
  runId: AutomationRunId,
});
export type AutomationRunStatusInput = typeof AutomationRunStatusInput.Type;

export const AutomationEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("automation.created"), automation: Automation }),
  Schema.Struct({ type: Schema.Literal("automation.updated"), automation: Automation }),
  Schema.Struct({
    type: Schema.Literal("automation.deleted"),
    automationId: AutomationId,
    projectId: ProjectId,
    occurredAt: IsoDateTime,
  }),
  Schema.Struct({ type: Schema.Literal("automation.run-updated"), run: AutomationRun }),
]);
export type AutomationEvent = typeof AutomationEvent.Type;
