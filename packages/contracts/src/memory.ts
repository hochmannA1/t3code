import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./orchestration.ts";

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
export const MemorySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  useMemories: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  generateMemories: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  dreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  idleMinutes: boundedInt(1, 1440).pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  maxSourcesPerPass: boundedInt(1, 20).pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  maxContextTokens: boundedInt(256, 8192).pipe(Schema.withDecodingDefault(Effect.succeed(2000))),
  modelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" }),
    ),
  ),
});
export type MemorySettings = typeof MemorySettings.Type;
export const DEFAULT_MEMORY_SETTINGS = Schema.decodeSync(MemorySettings)({});
export const MemorySettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  useMemories: Schema.optionalKey(Schema.Boolean),
  generateMemories: Schema.optionalKey(Schema.Boolean),
  dreaming: Schema.optionalKey(Schema.Boolean),
  idleMinutes: Schema.optionalKey(boundedInt(1, 1440)),
  maxSourcesPerPass: Schema.optionalKey(boundedInt(1, 20)),
  maxContextTokens: Schema.optionalKey(boundedInt(256, 8192)),
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type MemorySettingsPatch = typeof MemorySettingsPatch.Type;
export const MemoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const MemoryTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const MemoryText = TrimmedNonEmptyString.check(Schema.isMaxLength(12000));
const MemoryKeywords = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100))).check(
  Schema.isMaxLength(30),
);
export const MemoryEntry = Schema.Struct({
  id: MemoryId,
  projectId: Schema.NullOr(ProjectId),
  title: MemoryTitle,
  text: MemoryText,
  keywords: MemoryKeywords,
  sourceIds: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MemoryEntry = typeof MemoryEntry.Type;
export const MemoryRecommendationType = Schema.Literals(["task", "automation", "page"]);
export type MemoryRecommendationType = typeof MemoryRecommendationType.Type;
export const MemoryRecommendation = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  type: MemoryRecommendationType,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
});
export type MemoryRecommendation = typeof MemoryRecommendation.Type;
export const MemoryGetRecommendationsInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
});
export type MemoryGetRecommendationsInput = typeof MemoryGetRecommendationsInput.Type;
export const MemoryGetRecommendationsResult = Schema.Struct({
  recommendations: Schema.Array(MemoryRecommendation).check(Schema.isMaxLength(2)),
  reason: Schema.optional(Schema.Literals(["disabled", "no-memories", "no-suggestions"])),
  retryable: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type MemoryGetRecommendationsResult = typeof MemoryGetRecommendationsResult.Type;
export const MemoryThreadPolicy = Schema.Struct({
  useMemories: Schema.Boolean,
  generateMemories: Schema.Boolean,
});
export type MemoryThreadPolicy = typeof MemoryThreadPolicy.Type;
export const MemoryStateInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type MemoryStateInput = typeof MemoryStateInput.Type;
export const MemoryState = Schema.Struct({
  entries: Schema.Array(MemoryEntry),
  threadPolicy: MemoryThreadPolicy,
  status: Schema.Struct({
    pendingSources: NonNegativeInt,
    failedSources: NonNegativeInt,
    backfillCompletedAt: Schema.NullOr(IsoDateTime),
    lastConsolidatedAt: Schema.NullOr(IsoDateTime),
    lastDreamedAt: Schema.NullOr(IsoDateTime),
    lastError: Schema.NullOr(Schema.String),
    running: Schema.Boolean,
    memoryDirectory: Schema.String,
  }),
});
export type MemoryState = typeof MemoryState.Type;
export const MemoryUpsertInput = Schema.Struct({
  id: Schema.optionalKey(MemoryId),
  projectId: Schema.NullOr(ProjectId),
  title: MemoryTitle,
  text: MemoryText,
  keywords: Schema.optionalKey(MemoryKeywords),
  pinned: Schema.Boolean,
});
export type MemoryUpsertInput = typeof MemoryUpsertInput.Type;
export const MemoryForgetInput = Schema.Struct({ id: MemoryId });
export type MemoryForgetInput = typeof MemoryForgetInput.Type;
export const MemorySetThreadPolicyInput = Schema.Struct({
  threadId: ThreadId,
  useMemories: Schema.Boolean,
  generateMemories: Schema.Boolean,
});
export type MemorySetThreadPolicyInput = typeof MemorySetThreadPolicyInput.Type;
export class MemoryError extends Schema.TaggedErrorClass<MemoryError>()("MemoryError", {
  message: Schema.String,
}) {}
