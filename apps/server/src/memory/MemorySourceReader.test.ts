import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { make, sourceId, sourceRevision, sourceText } from "./MemorySourceReader.ts";

const EvidenceDate = Schema.Struct({ observedAt: Schema.String });
const decodeEvidenceDate = Schema.decodeUnknownEffect(Schema.fromJsonString(EvidenceDate));
const decodeConversationDates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(EvidenceDate)),
);
const encodeTextPayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);
const encodeRunPayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ userMessageId: Schema.String })),
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
  const status =
    options.state === "error"
      ? "failed"
      : options.state === "pending"
        ? "queued"
        : (options.state ?? "completed");
  const completedAt = options.completedAt === undefined ? at : options.completedAt;
  yield* sql`INSERT OR IGNORE INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project', 'Project', '/workspace', '[]', ${at}, ${at})`;
  yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
     created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default', ${at}, ${at}, NULL, NULL, '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages
    (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json) VALUES
    (${`${id}-user`}, ${id}, ${id}, NULL, 'user', 0, ${at}, ${at}, ${encodeTextPayload({ text: "Remember the deployment decision" })}),
    (${`${id}-assistant`}, ${id}, ${id}, NULL, 'assistant', ${options.assistantStreaming ?? 0}, ${at}, ${at}, ${encodeTextPayload({ text: options.assistantText ?? "Use a persistent volume" })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
    VALUES (${id}, ${id}, 1, 'codex', NULL, ${status}, ${at}, ${completedAt}, ${encodeRunPayload({ userMessageId: `${id}-user` })})`;
});

const prepare = Effect.gen(function* () {
  yield* runMigrations();
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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
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
      yield* sql`UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 'Final confirmed decision'), updated_at = ${later}
        WHERE message_id = 'first-assistant'`;
      const changed = yield* reader.discover({ at: end.at, rowId: end.rowId }, later, 10);
      assert.equal(changed[0]?.threadId, "first");
      assert.notEqual(sourceRevision(changed[0]!), sourceRevision(first));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("selects one latest source per historical chat and reads its bounded transcript", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("chat");
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json) VALUES
        ('chat-later-user', 'chat', 'chat-later', NULL, 'user', 0, ${later}, ${later}, '{"text":"The earlier decision applies here"}'),
        ('chat-later-assistant', 'chat', 'chat-later', NULL, 'assistant', 0, ${later}, ${later}, '{"text":"Keep using the persistent volume"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
        VALUES ('chat-later', 'chat', 2, 'codex', NULL, 'completed', ${later}, ${later}, '{"userMessageId":"chat-later-user"}')`;

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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("waits for late assistant finalization and the configured cutoff", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("late", { assistantStreaming: 1 });
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0, updated_at = ${later}
        WHERE message_id = 'late-assistant'`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, at, 10), []);
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows[0]?.at, later);
      assert.equal(sourceId(rows[0]!), "late/late");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("marks a completed source as active when its thread is running again", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("active");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
        VALUES ('new-turn', 'active', 2, 'codex', NULL, 'running', ${later}, NULL, '{"userMessageId":"new-turn-user"}')`;
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows[0]?.active, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("cannot read a deleted conversation or a cross-thread message reference", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("deleted");
      yield* seed("other");
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${later} WHERE thread_id = 'deleted'`;
      assert.isUndefined(
        yield* reader.read({ threadId: ThreadId.make("deleted"), turnId: "deleted" }),
      );
      yield* sql`UPDATE orchestration_v2_projection_runs
        SET payload_json = json_set(payload_json, '$.userMessageId', 'deleted-assistant') WHERE thread_id = 'other'`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
      assert.equal(
        (yield* Effect.flip(reader.projectForThread(ThreadId.make("deleted"))))._tag,
        "MemoryError",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("treats pending turns as active and ignores deleted threads", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("pending", { state: "pending", completedAt: null });
      assert.isTrue(yield* reader.hasActiveTurns());
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${later} WHERE thread_id = 'pending'`;
      assert.isFalse(yield* reader.hasActiveTurns());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not learn from an earlier answer while the final answer is streaming", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("multi");
      yield* sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('final-answer', 'multi', 'multi', NULL, 'assistant', 1, ${later}, ${later}, '{"text":"Final answer"}')`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'final-answer'`;
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.assistantText, "Final answer");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a user message that belongs to another run of the same thread", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("mismatch");
      yield* sql`UPDATE orchestration_v2_projection_messages SET run_id = 'unrelated-run'
        WHERE message_id = 'mismatch-user'`;
      assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("marks completed history active while another run is queued", () =>
    Effect.gen(function* () {
      const reader = yield* prepare;
      const sql = yield* SqlClient.SqlClient;
      yield* seed("queue-owner");
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
        VALUES ('queued-run', 'queue-owner', 2, 'codex', NULL, 'queued', ${later}, NULL, '{"userMessageId":"queued-message"}')`;
      const rows = yield* reader.discover({ at: "", rowId: 0 }, later, 10);
      assert.equal(rows[0]?.active, 1);
      assert.isTrue(yield* reader.hasActiveTurns());
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "retains legacy citations alongside V2 runs with unique cursors and authoritative deletion",
    () =>
      Effect.gen(function* () {
        const reader = yield* prepare;
        const sql = yield* SqlClient.SqlClient;
        yield* seed("upgraded");
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('upgraded', 'project', 'Legacy task', ${at}, ${at})`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
        ('old-user', 'upgraded', 'old-turn', 'user', 'Legacy question', 0, ${at}, ${at}),
        ('old-answer', 'upgraded', 'old-turn', 'assistant', 'Legacy answer', 0, ${at}, ${at})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES ('upgraded', 'old-turn', 'old-user', 'old-answer', 'completed', ${at}, ${at}, '[]')`;
        const first = (yield* reader.discover({ at: "", rowId: 0 }, later, 1))[0]!;
        const second = (yield* reader.discover({ at: first.at, rowId: first.rowId }, later, 1))[0]!;
        assert.equal(first.turnId, "old-turn");
        assert.equal(second.turnId, "upgraded");
        assert.notEqual(first.rowId, second.rowId);
        const transcript = yield* reader.readConversation(second);
        assert.include(transcript, "Legacy answer");
        assert.include(transcript, "Use a persistent volume");
        const sources = [first, second].map((row) => ({
          ...row,
          id: sourceId(row),
          kind: "turn" as const,
          revision: sourceRevision(row),
          attempts: 0,
          retryAt: "",
        }));
        assert.deepEqual([...(yield* reader.validSourceIds(sources))].sort(), [
          "upgraded/old-turn",
          "upgraded/upgraded",
        ]);
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${later} WHERE thread_id = 'upgraded'`;
        assert.deepEqual(yield* reader.discover({ at: "", rowId: 0 }, later, 10), []);
        assert.equal((yield* reader.validSourceIds(sources)).size, 0);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
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
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
