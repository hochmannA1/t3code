import { MemoryError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { fingerprint, type MemorySource } from "./MemoryStore.ts";
import { redactMemoryText } from "./redactMemoryText.ts";

const SourceRow = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.String,
  projectId: ProjectId,
  rowId: Schema.Number,
  at: Schema.String,
  revision: Schema.String,
  outcome: Schema.String,
  userText: Schema.String,
  assistantText: Schema.String,
  active: Schema.Number,
});
const ConversationRow = Schema.Struct({
  turnId: Schema.String,
  outcome: Schema.String,
  userText: Schema.String,
  assistantText: Schema.String,
});
const RecommendationProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
const encodeConversationEvidence = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        turnId: Schema.String,
        outcome: Schema.String,
        user: Schema.String,
        assistant: Schema.String,
      }),
    ),
  ),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    t.thread_id AS threadId, t.turn_id AS turnId, th.project_id AS projectId,
    t.row_id AS rowId, MAX(t.completed_at, u.updated_at, a.updated_at) AS at,
    (u.updated_at || ':' || a.updated_at || ':' || LENGTH(u.text) || ':' || LENGTH(a.text) || ':' || t.state) AS revision,
    t.state AS outcome,
    CASE WHEN LENGTH(u.text) <= 16000 THEN u.text ELSE SUBSTR(u.text, 1, 8000) || '\n[Middle of long message omitted]\n' || SUBSTR(u.text, -8000) END AS userText,
    CASE WHEN LENGTH(a.text) <= 16000 THEN a.text ELSE SUBSTR(a.text, 1, 8000) || '\n[Middle of long message omitted]\n' || SUBSTR(a.text, -8000) END AS assistantText,
    EXISTS(SELECT 1 FROM projection_turns active_turn WHERE active_turn.thread_id = t.thread_id AND active_turn.state = 'running') AS active
  `;
  const from = sql`
    FROM projection_turns t
    JOIN projection_threads th ON th.thread_id = t.thread_id
    JOIN projection_projects p ON p.project_id = th.project_id
    JOIN projection_thread_messages u ON u.message_id = t.pending_message_id AND u.thread_id = t.thread_id
    JOIN projection_thread_messages a ON a.message_id = t.assistant_message_id AND a.thread_id = t.thread_id
  `;
  const eligible = sql`
    t.turn_id IS NOT NULL AND t.completed_at IS NOT NULL
    AND t.state IN ('completed', 'interrupted', 'error')
    AND th.deleted_at IS NULL AND p.deleted_at IS NULL
    AND u.role = 'user' AND a.role = 'assistant' AND u.is_streaming = 0 AND a.is_streaming = 0
  `;
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SourceRow));
  const failed = () =>
    new MemoryError({ message: "Completed conversations could not be read for memory." });

  const discover = Effect.fn("MemorySourceReader.discover")(function* (
    cursor: { at: string; rowId: number },
    cutoff: string,
    limit: number,
  ) {
    return yield* sql`SELECT ${columns} ${from} WHERE ${eligible}
      AND MAX(t.completed_at, u.updated_at, a.updated_at) <= ${cutoff}
      AND (MAX(t.completed_at, u.updated_at, a.updated_at) > ${cursor.at}
        OR (MAX(t.completed_at, u.updated_at, a.updated_at) = ${cursor.at} AND t.row_id > ${cursor.rowId}))
      ORDER BY MAX(t.completed_at, u.updated_at, a.updated_at), t.row_id LIMIT ${limit}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(failed),
    );
  });

  const discoverChats = Effect.fn("MemorySourceReader.discoverChats")(function* (
    cursor: { at: string; rowId: number },
    cutoff: string,
    limit: number,
  ) {
    return yield* sql`SELECT ${columns} ${from} WHERE ${eligible}
      AND MAX(t.completed_at, u.updated_at, a.updated_at) <= ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM projection_turns newer
        JOIN projection_thread_messages newer_u
          ON newer_u.message_id = newer.pending_message_id AND newer_u.thread_id = newer.thread_id
        JOIN projection_thread_messages newer_a
          ON newer_a.message_id = newer.assistant_message_id AND newer_a.thread_id = newer.thread_id
        WHERE newer.thread_id = t.thread_id
          AND newer.turn_id IS NOT NULL AND newer.completed_at IS NOT NULL
          AND newer.state IN ('completed', 'interrupted', 'error')
          AND newer_u.role = 'user' AND newer_a.role = 'assistant'
          AND newer_u.is_streaming = 0 AND newer_a.is_streaming = 0
          AND MAX(newer.completed_at, newer_u.updated_at, newer_a.updated_at) <= ${cutoff}
          AND (
            MAX(newer.completed_at, newer_u.updated_at, newer_a.updated_at)
              > MAX(t.completed_at, u.updated_at, a.updated_at)
            OR (
              MAX(newer.completed_at, newer_u.updated_at, newer_a.updated_at)
                = MAX(t.completed_at, u.updated_at, a.updated_at)
              AND newer.row_id > t.row_id
            )
          )
      )
      AND (MAX(t.completed_at, u.updated_at, a.updated_at) > ${cursor.at}
        OR (MAX(t.completed_at, u.updated_at, a.updated_at) = ${cursor.at} AND t.row_id > ${cursor.rowId}))
      ORDER BY MAX(t.completed_at, u.updated_at, a.updated_at), t.row_id LIMIT ${limit}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(failed),
    );
  });

  const read = Effect.fn("MemorySourceReader.read")(function* (
    source: Pick<MemorySource, "threadId" | "turnId">,
  ) {
    const rows = yield* sql`SELECT ${columns} ${from} WHERE ${eligible}
      AND t.thread_id = ${source.threadId} AND t.turn_id = ${source.turnId} LIMIT 1`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(failed),
    );
    return rows[0];
  });

  const readConversation = Effect.fn("MemorySourceReader.readConversation")(function* (
    source: Pick<MemorySource, "threadId" | "rowId">,
  ) {
    const rows = yield* sql`SELECT
      t.turn_id AS turnId,
      t.state AS outcome,
      CASE WHEN LENGTH(u.text) <= 16000 THEN u.text ELSE SUBSTR(u.text, 1, 8000) || '\n[Middle of long message omitted]\n' || SUBSTR(u.text, -8000) END AS userText,
      CASE WHEN LENGTH(a.text) <= 16000 THEN a.text ELSE SUBSTR(a.text, 1, 8000) || '\n[Middle of long message omitted]\n' || SUBSTR(a.text, -8000) END AS assistantText
      FROM projection_turns t
      JOIN projection_threads th ON th.thread_id = t.thread_id
      JOIN projection_projects p ON p.project_id = th.project_id
      JOIN projection_thread_messages u ON u.message_id = t.pending_message_id AND u.thread_id = t.thread_id
      JOIN projection_thread_messages a ON a.message_id = t.assistant_message_id AND a.thread_id = t.thread_id
      WHERE ${eligible} AND t.thread_id = ${source.threadId} AND t.row_id <= ${source.rowId}
      ORDER BY t.row_id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConversationRow))),
      Effect.mapError(failed),
    );
    const transcript = encodeConversationEvidence(
      rows.map((row) => ({
        turnId: row.turnId,
        outcome: row.outcome,
        user: redactMemoryText(row.userText),
        assistant: redactMemoryText(row.assistantText),
      })),
    );
    if (transcript.length <= 80_000) return transcript;
    return `${transcript.slice(0, 40_000)}\n[Middle of long conversation omitted]\n${transcript.slice(-40_000)}`;
  });

  const projectForThread = Effect.fn("MemorySourceReader.projectForThread")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql`SELECT th.project_id AS projectId FROM projection_threads th
      JOIN projection_projects p ON p.project_id = th.project_id
      WHERE th.thread_id = ${threadId} AND th.deleted_at IS NULL AND p.deleted_at IS NULL`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ projectId: ProjectId }))),
      ),
      Effect.mapError(failed),
    );
    if (!rows[0]) return yield* new MemoryError({ message: "The memory thread no longer exists." });
    return rows[0].projectId;
  });

  const projectForRecommendation = Effect.fn("MemorySourceReader.projectForRecommendation")(
    function* (projectId: ProjectId) {
      const rows = yield* sql`
        SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
        FROM projection_projects
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecommendationProjectRow))),
        Effect.mapError(failed),
      );
      return rows[0];
    },
  );

  const projectsForRecommendations = Effect.fn("MemorySourceReader.projectsForRecommendations")(
    function* (projectIds: ReadonlyArray<ProjectId>, limit: number) {
      if (projectIds.length === 0) return [];
      return yield* sql`
        SELECT p.project_id AS "projectId", p.title, p.workspace_root AS "workspaceRoot"
        FROM projection_projects p
        LEFT JOIN projection_threads t ON t.project_id = p.project_id AND t.deleted_at IS NULL
        WHERE ${sql.in("p.project_id", projectIds)} AND p.deleted_at IS NULL
        GROUP BY p.project_id, p.title, p.workspace_root, p.updated_at
        ORDER BY MAX(p.updated_at, COALESCE(MAX(t.updated_at), p.updated_at)) DESC, p.project_id
        LIMIT ${limit}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecommendationProjectRow))),
        Effect.mapError(failed),
      );
    },
  );

  const hasActiveTurns = Effect.fn("MemorySourceReader.hasActiveTurns")(function* (since?: string) {
    const rows = yield* sql<{ active: number }>`SELECT EXISTS(
      SELECT 1 FROM projection_turns t JOIN projection_threads th ON th.thread_id = t.thread_id
      JOIN projection_projects p ON p.project_id = th.project_id
      WHERE th.deleted_at IS NULL AND p.deleted_at IS NULL AND (
        t.state IN ('pending', 'running') OR (${since ?? null} IS NOT NULL AND t.completed_at > ${since ?? null})
      )
    ) AS active`.pipe(Effect.mapError(failed));
    return rows[0]?.active === 1;
  });

  const validSourceIds = Effect.fn("MemorySourceReader.validSourceIds")(function* (
    sources: ReadonlyArray<MemorySource>,
  ) {
    if (!sources.length) return new Set<string>();
    const threads = [...new Set(sources.map((source) => source.threadId))];
    const rows = yield* sql<{ threadId: string; turnId: string }>`
      SELECT t.thread_id AS threadId, t.turn_id AS turnId FROM projection_turns t
      JOIN projection_threads th ON th.thread_id = t.thread_id
      JOIN projection_projects p ON p.project_id = th.project_id
      WHERE ${sql.in("t.thread_id", threads)} AND th.deleted_at IS NULL AND p.deleted_at IS NULL
    `.pipe(Effect.mapError(failed));
    return new Set(rows.map((row) => `${row.threadId}/${row.turnId}`));
  });

  return {
    discover,
    discoverChats,
    read,
    readConversation,
    projectForThread,
    projectForRecommendation,
    projectsForRecommendations,
    hasActiveTurns,
    validSourceIds,
  };
});

export type MemorySourceRow = typeof SourceRow.Type;
export const sourceId = (source: Pick<MemorySourceRow, "threadId" | "turnId">) =>
  `${source.threadId}/${source.turnId}`;
export const sourceText = (row: MemorySourceRow) =>
  JSON.stringify({
    outcome: row.outcome,
    user: redactMemoryText(row.userText),
    assistant: redactMemoryText(row.assistantText),
  });
export const sourceRevision = (row: MemorySourceRow) =>
  fingerprint(`${row.revision}\0${sourceText(row)}`);

export class MemorySourceReader extends Context.Service<
  MemorySourceReader,
  Effect.Success<typeof make>
>()("t3/memory/MemorySourceReader") {}
export const layer = Layer.effect(MemorySourceReader, make);
