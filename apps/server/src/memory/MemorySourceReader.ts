import { MemoryError, ProjectId, ThreadId } from "@t3tools/contracts";
import { isStandaloneProject } from "@t3tools/shared/projectContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
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
  observedAt: Schema.String,
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
        observedAt: Schema.String,
        outcome: Schema.String,
        user: Schema.String,
        assistant: Schema.String,
      }),
    ),
  ),
);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // V2's legacy importer keeps old messages but does not synthesize run rows.
  // Retain legacy evidence under its original source IDs; V2 thread metadata
  // takes precedence so deletion/archiving cannot revive stale V1 history.
  const threadQuery = sql`
    SELECT thread_id, project_id, title, updated_at, deleted_at
      FROM orchestration_v2_projection_threads
    UNION ALL
    SELECT t.thread_id, t.project_id, t.title, t.updated_at, t.deleted_at
      FROM projection_threads t
      WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v WHERE v.thread_id = t.thread_id)
  `;
  // V2 runs own the originating message ID. Message IDs alone are not a
  // membership check: bind both sides to the same thread and run. Choose the
  // latest assistant before testing streaming, so an unfinished final answer
  // cannot fall back to an earlier completed intermediate answer.
  const sourceQuery = sql`
    WITH visible_threads AS (${threadQuery})
    SELECT r.thread_id AS threadId, r.run_id AS turnId,
      t.project_id AS projectId, r.rowid * 2 + 1 AS rowId,
      MAX(r.completed_at, u.updated_at, a.updated_at) AS at,
      u.updated_at || ':' || a.updated_at || ':' || r.status AS revision,
      CASE r.status WHEN 'failed' THEN 'error' ELSE r.status END AS outcome,
      CASE WHEN LENGTH(json_extract(u.payload_json, '$.text')) > 16000
        THEN SUBSTR(json_extract(u.payload_json, '$.text'), 1, 8000)
          || '\n[Middle of long message omitted]\n'
          || SUBSTR(json_extract(u.payload_json, '$.text'), -8000)
        ELSE json_extract(u.payload_json, '$.text') END AS userText,
      CASE WHEN LENGTH(json_extract(a.payload_json, '$.text')) > 16000
        THEN SUBSTR(json_extract(a.payload_json, '$.text'), 1, 8000)
          || '\n[Middle of long message omitted]\n'
          || SUBSTR(json_extract(a.payload_json, '$.text'), -8000)
        ELSE json_extract(a.payload_json, '$.text') END AS assistantText,
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs busy
        WHERE busy.thread_id = r.thread_id
          AND busy.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      ) AS active
    FROM orchestration_v2_projection_runs r
    JOIN visible_threads t ON t.thread_id = r.thread_id
    JOIN projection_projects p ON p.project_id = t.project_id
    JOIN orchestration_v2_projection_messages u
      ON u.message_id = json_extract(r.payload_json, '$.userMessageId')
      AND u.thread_id = r.thread_id AND u.run_id = r.run_id
    JOIN orchestration_v2_projection_messages a
      ON a.message_id = (
        SELECT m.message_id FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = r.thread_id AND m.run_id = r.run_id AND m.role = 'assistant'
        ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
      )
    WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
      AND r.completed_at IS NOT NULL AND r.status IN ('completed', 'interrupted', 'failed')
      AND u.role = 'user' AND u.streaming = 0 AND a.streaming = 0
      AND json_type(u.payload_json, '$.text') = 'text'
      AND json_type(a.payload_json, '$.text') = 'text'
    UNION ALL
    SELECT r.thread_id AS threadId, r.turn_id AS turnId, t.project_id AS projectId,
      r.row_id * 2 AS rowId, MAX(r.completed_at, u.updated_at, a.updated_at) AS at,
      u.updated_at || ':' || a.updated_at || ':' || LENGTH(u.text) || ':' || LENGTH(a.text) || ':' || r.state AS revision,
      r.state AS outcome,
      CASE WHEN LENGTH(u.text) > 16000 THEN SUBSTR(u.text, 1, 8000)
        || '\n[Middle of long message omitted]\n' || SUBSTR(u.text, -8000) ELSE u.text END AS userText,
      CASE WHEN LENGTH(a.text) > 16000 THEN SUBSTR(a.text, 1, 8000)
        || '\n[Middle of long message omitted]\n' || SUBSTR(a.text, -8000) ELSE a.text END AS assistantText,
      (EXISTS (SELECT 1 FROM orchestration_v2_projection_runs busy
        WHERE busy.thread_id = r.thread_id
          AND busy.status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))
       OR (NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v WHERE v.thread_id = r.thread_id)
         AND EXISTS (SELECT 1 FROM projection_turns busy WHERE busy.thread_id = r.thread_id
           AND busy.state IN ('pending', 'running')))) AS active
    FROM projection_turns r
    JOIN visible_threads t ON t.thread_id = r.thread_id
    JOIN projection_projects p ON p.project_id = t.project_id
    JOIN projection_thread_messages u ON u.message_id = r.pending_message_id AND u.thread_id = r.thread_id
    JOIN projection_thread_messages a ON a.message_id = r.assistant_message_id AND a.thread_id = r.thread_id
    WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL
      AND r.turn_id IS NOT NULL AND r.completed_at IS NOT NULL
      AND r.state IN ('completed', 'interrupted', 'error')
      AND u.role = 'user' AND a.role = 'assistant' AND u.is_streaming = 0 AND a.is_streaming = 0
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs v WHERE v.run_id = r.turn_id)
  `;
  const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SourceRow));
  const failed = () =>
    new MemoryError({ message: "Completed conversations could not be read for memory." });

  const discover = Effect.fn("MemorySourceReader.discover")(function* (
    cursor: { at: string; rowId: number },
    cutoff: string,
    limit: number,
  ) {
    return yield* sql`WITH sources AS (${sourceQuery})
      SELECT * FROM sources WHERE at <= ${cutoff}
        AND (at > ${cursor.at} OR (at = ${cursor.at} AND rowId > ${cursor.rowId}))
      ORDER BY at, rowId LIMIT ${limit}`.pipe(Effect.flatMap(decodeRows), Effect.mapError(failed));
  });

  const discoverChats = Effect.fn("MemorySourceReader.discoverChats")(function* (
    cursor: { at: string; rowId: number },
    cutoff: string,
    limit: number,
  ) {
    return yield* sql`WITH sources AS (${sourceQuery})
      SELECT s.* FROM sources s WHERE s.at <= ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM sources newer
          WHERE newer.threadId = s.threadId AND newer.at <= ${cutoff}
            AND (newer.at > s.at OR (newer.at = s.at AND newer.rowId > s.rowId))
        )
        AND (s.at > ${cursor.at} OR (s.at = ${cursor.at} AND s.rowId > ${cursor.rowId}))
      ORDER BY s.at, s.rowId LIMIT ${limit}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(failed),
    );
  });

  const read = Effect.fn("MemorySourceReader.read")(function* (
    source: Pick<MemorySource, "threadId" | "turnId">,
  ) {
    const rows = yield* sql`WITH sources AS (${sourceQuery})
      SELECT * FROM sources
      WHERE threadId = ${source.threadId} AND turnId = ${source.turnId} LIMIT 1`.pipe(
      Effect.flatMap(decodeRows),
      Effect.mapError(failed),
    );
    return rows[0];
  });

  const readConversation = Effect.fn("MemorySourceReader.readConversation")(function* (
    source: Pick<MemorySource, "threadId" | "rowId">,
  ) {
    const rows = yield* sql`WITH sources AS (${sourceQuery})
      SELECT s.turnId, s.at AS observedAt, s.outcome, s.userText, s.assistantText
      FROM sources s JOIN sources anchor ON anchor.threadId = s.threadId
      WHERE anchor.threadId = ${source.threadId} AND anchor.rowId = ${source.rowId}
        AND (s.at < anchor.at OR (s.at = anchor.at AND s.rowId <= anchor.rowId))
      ORDER BY s.at, s.rowId`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConversationRow))),
      Effect.mapError(failed),
    );
    const transcript = encodeConversationEvidence(
      rows.map((row) => ({
        turnId: row.turnId,
        observedAt: row.observedAt,
        outcome: row.outcome,
        user: redactMemoryText(row.userText),
        assistant: redactMemoryText(row.assistantText),
      })),
    );
    if (transcript.length <= 80_000) return transcript;
    return `${transcript.slice(0, 40_000)}\n[Middle of long conversation omitted]\n${transcript.slice(-40_000)}`;
  });

  const threadProject = Effect.fn("MemorySourceReader.threadProject")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql`WITH threads AS (${threadQuery})
        SELECT p.project_id AS projectId, p.title, p.workspace_root AS workspaceRoot
        FROM projection_projects p
        JOIN threads t ON t.project_id = p.project_id
        WHERE t.thread_id = ${threadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecommendationProjectRow))),
      Effect.mapError(failed),
    );
    if (!rows[0]) return yield* new MemoryError({ message: "The memory thread no longer exists." });
    return rows[0];
  });

  const projectForThread = Effect.fn("MemorySourceReader.projectForThread")(function* (
    threadId: ThreadId,
  ) {
    return (yield* threadProject(threadId)).projectId;
  });

  const memoryScopeForThread = Effect.fn("MemorySourceReader.memoryScopeForThread")(function* (
    threadId: ThreadId,
  ) {
    const project = yield* threadProject(threadId);
    return isStandaloneProject(project) ? undefined : project.projectId;
  });

  const projectForRecommendation = Effect.fn("MemorySourceReader.projectForRecommendation")(
    function* (projectId: ProjectId) {
      const rows = yield* sql`
        SELECT p.project_id AS projectId, p.title, p.workspace_root AS workspaceRoot
        FROM projection_projects p
        WHERE p.deleted_at IS NULL AND p.project_id = ${projectId}
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
        WITH threads AS (${threadQuery})
        SELECT p.project_id AS projectId, p.title, p.workspace_root AS workspaceRoot
        FROM projection_projects p
        WHERE p.deleted_at IS NULL AND ${sql.in("p.project_id", projectIds)}
        ORDER BY MAX(p.updated_at, COALESCE((
          SELECT MAX(t.updated_at) FROM threads t
          WHERE t.project_id = p.project_id AND t.deleted_at IS NULL
        ), p.updated_at)) DESC, p.project_id
        LIMIT ${limit}
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RecommendationProjectRow))),
        Effect.mapError(failed),
      );
    },
  );

  const hasActiveTurns = Effect.fn("MemorySourceReader.hasActiveTurns")(function* (since?: string) {
    const rows = yield* sql<{ active: number }>`WITH threads AS (${threadQuery})
      SELECT EXISTS (
        SELECT 1 FROM threads t JOIN projection_projects p ON p.project_id = t.project_id
        WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL AND (
          EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
            AND (r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting') OR r.completed_at > ${since ?? null}))
          OR (NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v WHERE v.thread_id = t.thread_id)
            AND EXISTS (SELECT 1 FROM projection_turns r WHERE r.thread_id = t.thread_id
              AND (r.state IN ('pending', 'running') OR r.completed_at > ${since ?? null})))
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
      WITH threads AS (${threadQuery}), identities AS (
        SELECT thread_id, run_id AS turn_id FROM orchestration_v2_projection_runs
        UNION SELECT thread_id, turn_id FROM projection_turns WHERE turn_id IS NOT NULL
      )
      SELECT r.thread_id AS threadId, r.turn_id AS turnId
      FROM threads t JOIN projection_projects p ON p.project_id = t.project_id
      JOIN identities r ON r.thread_id = t.thread_id
      WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND ${sql.in("t.thread_id", threads)}
    `.pipe(Effect.mapError(failed));
    return new Set(rows.map((row) => `${row.threadId}/${row.turnId}`));
  });

  return {
    discover,
    discoverChats,
    read,
    readConversation,
    projectForThread,
    memoryScopeForThread,
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
    observedAt: row.at,
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
