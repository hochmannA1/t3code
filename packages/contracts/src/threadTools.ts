import { MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

export class ThreadToolError extends Schema.TaggedErrorClass<ThreadToolError>()("ThreadToolError", {
  code: Schema.Literals(["access-disabled", "not-found", "query-failed"]),
  message: Schema.String,
}) {}

const PageInput = {
  scope: Schema.optionalKey(Schema.Literals(["project", "environment"])),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
};

export const ThreadListInput = Schema.Struct({
  ...PageInput,
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  sortBy: Schema.optionalKey(Schema.Literals(["updatedAt", "createdAt", "title"])),
  sortDirection: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
});

export const ThreadSearchInput = Schema.Struct({
  ...PageInput,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});

export const ThreadReadInput = Schema.Struct({
  ...PageInput,
  threadId: ThreadId,
  messageId: Schema.optionalKey(MessageId),
  textOffset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 })),
  ),
});

export const McpThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});

const PageContext = {
  currentThreadId: ThreadId,
  currentProjectId: ProjectId,
  nextOffset: Schema.NullOr(Schema.Int),
};

export const ThreadListResult = Schema.Struct({
  ...PageContext,
  threads: Schema.Array(McpThreadSummary),
});

export const McpThreadSearchMatch = Schema.Struct({
  ...McpThreadSummary.fields,
  source: Schema.Literals(["title", "user", "assistant"]),
  messageId: Schema.NullOr(MessageId),
  snippet: Schema.String,
});

export const ThreadSearchResult = Schema.Struct({
  ...PageContext,
  matches: Schema.Array(McpThreadSearchMatch),
});

export const McpThreadMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  createdAt: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
  nextTextOffset: Schema.NullOr(Schema.Int),
});

export const ThreadReadResult = Schema.Struct({
  ...PageContext,
  thread: McpThreadSummary,
  messages: Schema.Array(McpThreadMessage),
});
