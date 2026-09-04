import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  McpThreadSearchMatch,
  McpThreadSummary,
  ThreadToolError,
  MessageId,
  ThreadListInput,
  ThreadSearchInput,
  ThreadReadInput,
} from "@t3tools/contracts";
import { ThreadToolkit } from "./tools.ts";

const queryFailed = () =>
  new ThreadToolError({ code: "query-failed", message: "Thread history could not be read." });
const notFound = () =>
  new ThreadToolError({ code: "not-found", message: "Thread not found in the requested scope." });

const literalPattern = (text: string) => `%${text.replace(/[!%_]/g, "!$&")}%`;

export function makeThreadToolkitHandlers(sql: SqlClient.SqlClient) {
  const columns = sql`
    threads.thread_id AS "threadId",
    threads.project_id AS "projectId",
    substr(projects.title, 1, 500) AS "projectTitle",
    substr(threads.title, 1, 500) AS title,
    threads.created_at AS "createdAt",
    threads.updated_at AS "updatedAt",
    threads.archived_at AS "archivedAt"
  `;

  const visibleMessages = sql`
    messages.is_streaming = 0 AND (
      messages.role = 'user' OR (
        messages.role = 'assistant' AND (messages.thread_id, messages.message_id) IN (
          SELECT turns.thread_id, turns.assistant_message_id FROM projection_turns AS turns
          WHERE turns.assistant_message_id IS NOT NULL
            AND turns.state IN ('completed', 'interrupted', 'error')
        )
      )
    )
  `;

  const currentTask = Effect.fn("ThreadToolkit.currentTask")(function* () {
    const invocation = yield* McpInvocationContext.McpInvocationContext;
    if (!invocation.capabilities.has("threads")) {
      return yield* new ThreadToolError({
        code: "access-disabled",
        message: "Thread history access is unavailable for this agent session.",
      });
    }
    const threads = yield* sql`
      SELECT ${columns}
      FROM projection_threads AS threads
      INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      WHERE threads.thread_id = ${invocation.threadId}
        AND threads.deleted_at IS NULL AND projects.deleted_at IS NULL
      LIMIT 1
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(McpThreadSummary))),
      Effect.mapError(queryFailed),
    );
    const thread = threads[0];
    if (!thread) return yield* notFound();
    return { currentThreadId: invocation.threadId, currentProjectId: thread.projectId };
  });

  const filters = (
    input: { scope?: "project" | "environment"; includeArchived?: boolean },
    projectId: string,
  ) => sql`
    threads.deleted_at IS NULL AND projects.deleted_at IS NULL
    AND (${input.includeArchived === true ? 1 : 0} = 1 OR threads.archived_at IS NULL)
    AND (${input.scope === "environment" ? 1 : 0} = 1 OR threads.project_id = ${projectId})
  `;

  return {
    thread_list: Effect.fn("ThreadToolkit.list")(function* (input: typeof ThreadListInput.Type) {
      const context = yield* currentTask();
      const limit = input.limit ?? 25;
      const offset = input.offset ?? 0;
      const sortColumn =
        input.sortBy === "title"
          ? sql`threads.title COLLATE NOCASE`
          : input.sortBy === "createdAt"
            ? sql`threads.created_at`
            : sql`threads.updated_at`;
      const direction = input.sortDirection === "asc" ? sql`ASC` : sql`DESC`;
      const titleFilter =
        input.title === undefined
          ? sql`1 = 1`
          : sql`threads.title LIKE ${literalPattern(input.title)} ESCAPE '!'`;
      const rows = yield* sql`
        SELECT ${columns}
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE ${filters(input, context.currentProjectId)} AND ${titleFilter}
        ORDER BY ${sortColumn} ${direction}, threads.thread_id ASC
        LIMIT ${limit + 1} OFFSET ${offset}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(McpThreadSummary))),
        Effect.mapError(queryFailed),
      );
      return {
        ...context,
        threads: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    }),
    thread_search: Effect.fn("ThreadToolkit.search")(function* (
      input: typeof ThreadSearchInput.Type,
    ) {
      const context = yield* currentTask();
      const limit = input.limit ?? 25;
      const offset = input.offset ?? 0;
      const pattern = literalPattern(input.query);
      const rows = yield* sql`
        WITH candidates AS (
          SELECT threads.thread_id, 'title' AS source, NULL AS message_id,
            substr(threads.title, max(1, instr(lower(threads.title), lower(${input.query})) - 100), 500) AS snippet,
            0 AS source_rank, threads.created_at AS match_created_at
          FROM projection_threads AS threads
          INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
          WHERE ${filters(input, context.currentProjectId)}
            AND threads.title LIKE ${pattern} ESCAPE '!'
          UNION ALL
          SELECT threads.thread_id, messages.role AS source, messages.message_id,
            substr(messages.text, max(1, instr(lower(messages.text), lower(${input.query})) - 100), 500) AS snippet,
            1 AS source_rank, messages.created_at AS match_created_at
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
          WHERE ${filters(input, context.currentProjectId)} AND ${visibleMessages}
            AND messages.text LIKE ${pattern} ESCAPE '!'
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY thread_id ORDER BY source_rank ASC, match_created_at DESC, message_id ASC
          ) AS match_rank FROM candidates
        )
        SELECT ${columns}, ranked.source, ranked.message_id AS "messageId", ranked.snippet
        FROM ranked
        INNER JOIN projection_threads AS threads ON threads.thread_id = ranked.thread_id
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE ranked.match_rank = 1
        ORDER BY threads.updated_at DESC, threads.thread_id ASC
        LIMIT ${limit + 1} OFFSET ${offset}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(McpThreadSearchMatch))),
        Effect.mapError(queryFailed),
      );
      return {
        ...context,
        matches: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    }),
    thread_read: Effect.fn("ThreadToolkit.read")(function* (input: typeof ThreadReadInput.Type) {
      const context = yield* currentTask();
      const limit = input.limit ?? 20;
      const offset = input.offset ?? 0;
      const textOffset = input.textOffset ?? 0;
      const threads = yield* sql`
        SELECT ${columns}
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${input.threadId} AND ${filters(input, context.currentProjectId)}
        LIMIT 1
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(McpThreadSummary))),
        Effect.mapError(queryFailed),
      );
      const thread = threads[0];
      if (!thread) return yield* notFound();
      const messageFilter =
        input.messageId === undefined ? sql`1 = 1` : sql`messages.message_id = ${input.messageId}`;
      const rows = yield* sql`
        SELECT messages.message_id AS "messageId", messages.role, messages.created_at AS "createdAt",
          substr(messages.text, ${textOffset + 1}, 4000) AS text,
          length(messages.text) > ${textOffset + 4000} AS truncated
        FROM projection_thread_messages AS messages
        INNER JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${input.threadId} AND ${filters(input, context.currentProjectId)}
          AND ${visibleMessages} AND ${messageFilter}
        ORDER BY messages.created_at ASC, messages.message_id ASC
        LIMIT ${limit + 1} OFFSET ${offset}
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                messageId: MessageId,
                role: Schema.Literals(["user", "assistant"]),
                createdAt: Schema.String,
                text: Schema.String,
                truncated: Schema.Number,
              }),
            ),
          ),
        ),
        Effect.mapError(queryFailed),
      );
      return {
        ...context,
        thread,
        messages: rows.slice(0, limit).map((message) => ({
          ...message,
          truncated: message.truncated !== 0,
          nextTextOffset: message.truncated !== 0 ? textOffset + 4000 : null,
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    }),
  } satisfies Parameters<typeof ThreadToolkit.toLayer>[0];
}

export const ThreadToolkitHandlersLive = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return ThreadToolkit.toLayer(makeThreadToolkitHandlers(sql));
  }),
);
