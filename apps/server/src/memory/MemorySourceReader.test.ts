import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { make, sourceId, sourceRevision, sourceText } from "./MemorySourceReader.ts";

const EvidenceDate = Schema.Struct({ observedAt: Schema.String });
const decodeEvidenceDate = Schema.decodeUnknownEffect(Schema.fromJsonString(EvidenceDate));
const decodeConversationDates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(EvidenceDate)),
);
const at = "2026-09-04T10:00:00.000Z";
const later = "2026-09-04T10:10:00.000Z";
const seed = Effect.fn("seedMemorySource")(function* (
  id: string,
  options: {
    completedAt?: string | null;
    assistantStreaming?: number;
    state?: string;
    assistantText?: string;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/workspace', '[]', ${at}, ${at})`;
  yield* sql`INSERT OR IGNORE INTO projection_threads
    (thread_id, project_id, title, created_at, updated_at)
    VALUES (${id}, 'project', 'Thread', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
    (${`${id}-user`}, ${id}, ${id}, 'user', 'Remember the deployment decision', 0, ${at}, ${at}),
    (${`${id}-assistant`}, ${id}, ${id}, 'assistant', ${options.assistantText ?? "Use a persistent volume"}, ${options.assistantStreaming ?? 0}, ${at}, ${at})`;
  yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
    VALUES (${id}, ${id}, ${`${id}-user`}, ${`${id}-assistant`}, ${options.state ?? "completed"}, ${at}, ${options.completedAt === undefined ? at : options.completedAt}, '[]')`;
});

const prepare = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 43 });
  return yield* make;
});

describe("MemorySourceReader", () => {
  it.effect("only discovers completed non-streaming messages and retains failed outcomes", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      yield* seed("complete");
      yield* seed("streaming", { assistantStreaming: 1 });
      yield* seed("running", { state: "running" });
      yield* seed("unfinished", { completedAt: null });
      yield* seed("failed", { state: "error" });
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 20);
      assert.deepEqual(
        rows.map((row) => [row.threadId, row.outcome]),
        [
          ["complete", "completed"],
          ["failed", "error"],
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("paginates equal timestamps by row ID and rediscovers later finalized text", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("first");
      yield* seed("second");
      const first = (yield* reader.discover({ at: "", rowId: 0 }, later, 1))[0]!;
      const next = yield* reader.discover({ at: first.at, rowId: first.rowId }, later, 1);
      assert.equal(next[0]?.threadId, "second");
      const end = next[0]!;
      yield* sql`UPDATE projection_thread_messages SET text = 'Final confirmed decision', updated_at = ${later}
        WHERE message_id = 'first-assistant'`;
      const changed = yield* reader.discover({ at: end.at, rowId: end.rowId }, later, 10);
      assert.equal(changed[0]?.threadId, "first");
      assert.notEqual(sourceRevision(changed[0]!), sourceRevision(first));
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("selects one latest source per historical chat and reads its bounded transcript", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("chat");
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
        ('chat-later-user', 'chat', 'chat-later', 'user', 'The earlier decision applies here', 0, ${later}, ${later}),
        ('chat-later-assistant', 'chat', 'chat-later', 'assistant', 'Keep using the persistent volume', 0, ${later}, ${later})`;
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES ('chat', 'chat-later', 'chat-later-user', 'chat-later-assistant', 'completed', ${later}, ${later}, '[]')`;

      const rows = yield* reader.discoverChats({ at: "", rowId: 0 }, later, 10);
      assert.deepEqual(
        rows.map((row) => row.turnId),
        ["chat-later"],
      );
      const transcript = yield* reader.readConversation(rows[0]!);
      assert.include(transcript, "Remember the deployment decision");
      assert.include(transcript, "The earlier decision applies here");
      assert.include(transcript, "Keep using the persistent volume");
      const conversation = yield* decodeConversationDates(transcript);
      assert.deepEqual(
        conversation.map((turn) => turn.observedAt),
        [at, later],
      );
      assert.equal((yield* decodeEvidenceDate(sourceText(rows[0]!))).observedAt, later);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("waits for late assistant finalization and the configured cutoff", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("late", { assistantStreaming: 1 });
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
      yield* sql`UPDATE projection_thread_messages SET is_streaming = 0, updated_at = ${later}
        WHERE message_id = 'late-assistant'`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, at, 10), []);
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows[0]?.at, later);
      assert.equal(sourceId(rows[0]!), "late/late");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("marks a completed source as active when its thread is running again", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("active");
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES ('active', 'new-turn', 'running', ${later}, '[]')`;
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows[0]?.active, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("cannot read a deleted conversation or a cross-thread message reference", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("deleted");
      yield* seed("other");
      yield* sql`UPDATE projection_threads SET deleted_at = ${later} WHERE thread_id = 'deleted'`;
      assert.isUndefined(
        yield* reader.read({ threadId: ThreadId.make("deleted"), turnId: "deleted" }),
      );
      yield* sql`UPDATE projection_turns SET assistant_message_id = 'deleted-assistant' WHERE thread_id = 'other'`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
      assert.equal(
        (yield* Effect.flip(reader.projectForThread(ThreadId.make("deleted"))))._tag,
        "MemoryError",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("validates saved evidence against current project and thread existence", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("evidence");
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      const sources = rows.map((row) => ({
        ...row,
        id: sourceId(row),
        revision: sourceRevision(row),
        kind: "turn" as const,
        attempts: 0,
        retryAt: "",
      }));
      assert.deepEqual([...(yield* reader.validSourceIds(sources))], ["evidence/evidence"]);
      yield* sql`UPDATE projection_projects SET deleted_at = ${later} WHERE project_id = 'project'`;
      assert.equal((yield* reader.validSourceIds(sources)).size, 0);
      assert.equal((yield* reader.validSourceIds([])).size, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("treats pending turns as active and ignores deleted threads", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("pending", { state: "pending", completedAt: null });
      assert.isTrue(yield* reader.hasActiveTurns());
      yield* sql`UPDATE projection_threads SET deleted_at = ${later} WHERE thread_id = 'pending'`;
      assert.isFalse(yield* reader.hasActiveTurns());
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("bounds source text while retaining the start and final conclusion", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      yield* seed("long", { assistantText: `Start${"x".repeat(40_000)}Conclusion` });
      const row = (yield* reader.discover({ at: "", rowId: 0 }, later, 1))[0]!;
      assert.isBelow(row.assistantText.length, 16_100);
      assert.isTrue(row.assistantText.startsWith("Start"));
      assert.isTrue(row.assistantText.endsWith("Conclusion"));
      assert.include(row.assistantText, "Middle of long message omitted");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
