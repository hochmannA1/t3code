import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_MEMORY_SETTINGS,
  ProjectId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { MemoryGenerationInput } from "../textGeneration/MemoryGeneration.ts";
import { make } from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Sources from "./MemorySourceReader.ts";

const threadId = ThreadId.make("memory-thread");
const projectId = ProjectId.make("memory-project");
const sourceTime = "1970-01-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Memory project', '/workspace', '[]', ${sourceTime}, ${sourceTime})`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${threadId}, ${projectId}, 'Memory thread', ${sourceTime}, ${sourceTime})`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
    ('user', ${threadId}, 'turn', 'user', 'Use persistent workspace storage', 0, ${sourceTime}, ${sourceTime}),
    ('assistant', ${threadId}, 'turn', 'assistant', 'Confirmed persistent storage', 0, ${sourceTime}, ${sourceTime})`;
  yield* sql`INSERT INTO projection_turns
    (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
    VALUES (${threadId}, 'turn', 'user', 'assistant', 'completed', ${sourceTime}, ${sourceTime}, '[]')`;
});

const insertCompletedTurns = Effect.fn("test.insertCompletedTurns")(function* (
  targetThreadId: ThreadId,
  count: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let index = 0; index < count; index++) {
        const turnId = `${targetThreadId}-extra-${index}`;
        const userId = `${turnId}-user`;
        const assistantId = `${turnId}-assistant`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
        (${userId}, ${targetThreadId}, ${turnId}, 'user', 'Remember project conventions', 0, ${sourceTime}, ${sourceTime}),
        (${assistantId}, ${targetThreadId}, ${turnId}, 'assistant', 'Confirmed project conventions', 0, ${sourceTime}, ${sourceTime})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES (${targetThreadId}, ${turnId}, ${userId}, ${assistantId}, 'completed', ${sourceTime}, ${sourceTime}, '[]')`;
      }
    }),
  );
});

const insertCompletedThreads = Effect.fn("test.insertCompletedThreads")(function* (count: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (let index = 0; index < count; index++) {
        const historicalThreadId = ThreadId.make(`history-thread-${index}`);
        const turnId = `history-turn-${index}`;
        const userId = `${turnId}-user`;
        const assistantId = `${turnId}-assistant`;
        yield* sql`INSERT INTO projection_threads
          (thread_id, project_id, title, created_at, updated_at, settled_at)
          VALUES (${historicalThreadId}, ${projectId}, 'Completed history', ${sourceTime}, ${sourceTime}, ${sourceTime})`;
        yield* sql`INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at) VALUES
          (${userId}, ${historicalThreadId}, ${turnId}, 'user', 'Remember this historical decision', 0, ${sourceTime}, ${sourceTime}),
          (${assistantId}, ${historicalThreadId}, ${turnId}, 'assistant', 'Confirmed historical decision', 0, ${sourceTime}, ${sourceTime})`;
        yield* sql`INSERT INTO projection_turns
          (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at, completed_at, checkpoint_files_json)
          VALUES (${historicalThreadId}, ${turnId}, ${userId}, ${assistantId}, 'completed', ${sourceTime}, ${sourceTime}, '[]')`;
      }
    }),
  );
});

const resultFor = (input: MemoryGenerationInput) => ({
  entries: [
    {
      title:
        input.mode === "dream"
          ? "Dreamed storage decision"
          : input.mode === "consolidate"
            ? "Consolidated storage decision"
            : "Storage decision",
      text: "Workspace state uses persistent storage. Verify the current volume configuration.",
      scope: "project" as const,
      keywords: ["storage"],
      sourceIds: input.sources.map((source) => source.id),
    },
  ],
});

const generationWith = (generateMemory: TextGeneration["Service"]["generateMemory"]) =>
  TextGeneration.of({
    generateMemory,
    generateCommitMessage: () => Effect.die("Unexpected commit generation"),
    generatePrContent: () => Effect.die("Unexpected PR generation"),
    generateBranchName: () => Effect.die("Unexpected branch generation"),
    generateThreadTitle: () => Effect.die("Unexpected title generation"),
  });

const setup = (generateMemory: TextGeneration["Service"]["generateMemory"]) =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seed;
    const store = yield* Store.make;
    const reader = yield* Sources.make;
    const service = yield* make.pipe(
      Effect.provideService(Store.MemoryStore, store),
      Effect.provideService(Sources.MemorySourceReader, reader),
      Effect.provideService(TextGeneration, generationWith(generateMemory)),
    );
    return { service, store, reader };
  });

const dependencies = () =>
  Layer.mergeAll(
    NodeSqliteClient.layerMemory(),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-service-" }),
    ServerSettings.layerTest(),
  ).pipe(Layer.provideMerge(NodeServices.layer));

describe("memory lifecycle", () => {
  it.effect("waits for the configured idle time before processing an older backlog", () =>
    Effect.gen(function* () {
      const inputs: MemoryGenerationInput[] = [];
      const { service } = yield* setup((input) =>
        Effect.sync(() => {
          inputs.push(input);
          return resultFor(input);
        }),
      );
      yield* TestClock.adjust("10 minutes");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES (${threadId}, 'recent-turn', 'completed', ${sourceTime}, '1970-01-01T00:10:00.000Z', '[]')`;
      yield* service.tick();
      assert.deepEqual(inputs, []);
      yield* TestClock.adjust("4 minutes");
      yield* service.tick();
      assert.deepEqual(inputs, []);
      yield* TestClock.adjust("1 minute");
      yield* service.tick();
      assert.deepEqual(
        inputs.map((input) => input.mode),
        ["extract"],
      );
    }).pipe(Effect.provide(dependencies())),
  );
  it.effect("backfills archived history oldest-first and resumes across a service restart", () =>
    Effect.gen(function* () {
      const extracted: string[] = [];
      const generateMemory: TextGeneration["Service"]["generateMemory"] = (input) =>
        Effect.sync(() => {
          if (input.mode === "extract") extracted.push(input.sources[0]!.id);
          if (input.mode !== "extract") return resultFor(input);
          return {
            entries: Array.from({ length: 8 }, (_, index) => ({
              ...resultFor(input).entries[0]!,
              title: `Historical decision ${index}`,
            })),
          };
        });
      const { service, store, reader } = yield* setup(generateMemory);
      const sql = yield* SqlClient.SqlClient;
      yield* insertCompletedThreads(69);
      yield* sql`UPDATE projection_threads
          SET archived_at = ${sourceTime}, settled_at = ${sourceTime}
          WHERE thread_id = ${threadId}`;
      yield* TestClock.adjust("10 minutes");

      for (let index = 0; index < 5; index++) yield* service.tick();
      assert.equal(extracted.length, 20);
      assert.isNull((yield* store.read()).backfillCompletedAt);

      const restarted = yield* make.pipe(
        Effect.provideService(Store.MemoryStore, store),
        Effect.provideService(Sources.MemorySourceReader, reader),
        Effect.provideService(TextGeneration, generationWith(generateMemory)),
      );
      for (let index = 0; index < 20; index++) yield* restarted.tick();

      assert.deepEqual(extracted, [
        `${threadId}/turn`,
        ...Array.from(
          { length: 69 },
          (_, index) => `history-thread-${index}/history-turn-${index}`,
        ),
      ]);
      const manifest = yield* store.read();
      assert.isNotNull(manifest.backfillStartedAt);
      assert.isNotNull(manifest.backfillCompletedAt);
      assert.equal(manifest.pending.length, 0);
      assert.isAtMost(manifest.entries.length, 512);
      assert.isNotNull((yield* restarted.getState({})).status.backfillCompletedAt);
    }).pipe(Effect.provide(dependencies())),
  );
  it.effect(
    "paused learning clears queued work and cannot starve another thread behind 64 sources",
    () =>
      Effect.gen(function* () {
        const inputs: MemoryGenerationInput[] = [];
        const { service, store } = yield* setup((input) =>
          Effect.sync(() => {
            inputs.push(input);
            return resultFor(input);
          }),
        );
        yield* insertCompletedTurns(threadId, 63);
        const activeThreadId = ThreadId.make("active-memory-thread");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES (${activeThreadId}, ${projectId}, 'Active learning thread', ${sourceTime}, ${sourceTime})`;
        yield* insertCompletedTurns(activeThreadId, 1);
        const reader = yield* Sources.make;
        const queued = yield* reader.discover({ at: "", rowId: 0 }, sourceTime, 64);
        yield* store.update((current) =>
          Effect.succeed({
            manifest: {
              ...current,
              pending: queued.map((row) => ({
                id: Sources.sourceId(row),
                revision: Sources.sourceRevision(row),
                at: row.at,
                rowId: row.rowId,
                threadId: row.threadId,
                turnId: row.turnId,
                projectId: row.projectId,
                kind: "turn",
                attempts: 0,
                retryAt: "",
              })),
            },
            result: undefined,
          }),
        );
        assert.equal((yield* store.read()).pending.length, 64);
        yield* service.setThreadPolicy({ threadId, useMemories: true, generateMemories: false });
        assert.equal((yield* store.read()).pending.length, 0);
        yield* TestClock.adjust("10 minutes");
        yield* service.tick();
        assert.equal(inputs.length, 1);
        assert.equal((yield* store.read()).pending.length, 0);
        const extracts = inputs.filter((input) => input.mode === "extract");
        assert.equal(extracts.length, 1);
        assert.isTrue(extracts[0]!.sources[0]!.id.startsWith(`${activeThreadId}/`));
        assert.equal((yield* store.read()).pending.length, 0);
      }).pipe(Effect.provide(dependencies())),
  );

  it.effect("quarantines a poison source without blocking newer historical conversations", () =>
    Effect.gen(function* () {
      const extracted: string[] = [];
      const evidence: string[] = [];
      const { service, store } = yield* setup((input) => {
        if (input.mode !== "extract") return Effect.succeed(resultFor(input));
        const id = input.sources[0]!.id;
        extracted.push(id);
        evidence.push(input.sources[0]!.text);
        return id === `${threadId}/turn`
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateMemory",
                detail: "Invalid historical output",
              }),
            )
          : Effect.succeed(resultFor(input));
      });
      yield* insertCompletedThreads(1);
      yield* TestClock.adjust("10 minutes");
      yield* service.tick();
      assert.include(extracted, "history-thread-0/history-turn-0");

      for (const delay of ["1 minute", "2 minutes", "4 minutes", "8 minutes"] as const) {
        yield* TestClock.adjust(delay);
        yield* service.tick();
      }
      yield* service.tick();

      const manifest = yield* store.read();
      assert.deepEqual(manifest.pending, []);
      assert.equal(manifest.failed.length, 1);
      assert.equal(manifest.failed[0]?.id, `${threadId}/turn`);
      assert.isNotNull(manifest.backfillCompletedAt);
      assert.equal((yield* service.getState({})).status.failedSources, 1);

      yield* service.runNow({});
      assert.equal((yield* store.read()).failed.length, 0);
      assert.equal((yield* store.read()).pending[0]?.attempts, 0);
      yield* service.tick();
      assert.isTrue(evidence.at(-1)?.startsWith("["));
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect(
    "drops metadata for zero-output sources while keeping their durable scan checkpoint",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const { service, store } = yield* setup(() =>
          Effect.sync(() => {
            calls++;
            return { entries: [] };
          }),
        );
        yield* insertCompletedTurns(threadId, 8);
        yield* TestClock.adjust("10 minutes");
        yield* service.tick();
        yield* service.tick();
        yield* service.tick();
        const state = yield* store.read();
        assert.equal(calls, 1);
        assert.deepEqual(state.sources, {});
        assert.deepEqual(state.pending, []);
        assert.deepEqual(state.entries, []);
        assert.isAbove(state.cursor.rowId, 0);
        yield* service.tick();
        assert.equal(calls, 1);
      }).pipe(Effect.provide(dependencies())),
  );

  it.effect(
    "extracts after idle, consolidates daily, and dreams weekly using the configured model",
    () =>
      Effect.gen(function* () {
        const inputs: MemoryGenerationInput[] = [];
        const { service, store } = yield* setup((input) =>
          Effect.sync(() => {
            inputs.push(input);
            return resultFor(input);
          }),
        );
        yield* TestClock.adjust("10 minutes");
        yield* service.tick();
        assert.deepEqual(
          inputs.map((input) => input.mode),
          ["extract"],
        );
        assert.deepEqual(inputs[0]?.modelSelection, DEFAULT_MEMORY_SETTINGS.modelSelection);
        let state = yield* service.getState({ threadId });
        assert.equal(state.entries.length, 1);
        assert.equal(state.entries[0]?.title, "Storage decision");
        assert.isNull(state.status.lastConsolidatedAt);
        assert.isNull(state.status.lastDreamedAt);

        yield* TestClock.adjust("24 hours");
        yield* service.tick();
        yield* service.tick();
        assert.deepEqual(
          inputs.map((input) => input.mode),
          ["extract", "consolidate"],
        );
        state = yield* service.getState({ threadId });
        assert.equal(state.entries[0]?.title, "Consolidated storage decision");
        assert.isNotNull(state.status.lastConsolidatedAt);
        assert.isNull(state.status.lastDreamedAt);

        yield* TestClock.adjust("6 days");
        yield* service.tick();
        yield* service.tick();
        yield* service.tick();
        assert.deepEqual(
          inputs.map((input) => input.mode),
          ["extract", "consolidate", "dream"],
        );
        state = yield* service.getState({ threadId });
        assert.equal(state.entries[0]?.title, "Dreamed storage decision");
        assert.deepEqual(state.entries[0]?.sourceIds, [`${threadId}/turn`]);
        assert.isNotNull(state.status.lastDreamedAt);
        assert.equal(state.status.pendingSources, 0);
        assert.include(yield* service.contextForThread(threadId, "storage"), "persistent storage");
        assert.equal((yield* store.read()).pending.length, 0);
        yield* service.tick();
        assert.equal(inputs.length, 3);
      }).pipe(Effect.provide(dependencies())),
  );

  it.effect("persists a failed extraction and retries after its due time", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { service, store } = yield* setup((input) => {
        calls++;
        return calls === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateMemory",
                detail: "Temporary provider failure",
              }),
            )
          : Effect.succeed(resultFor(input));
      });
      yield* TestClock.adjust("10 minutes");
      yield* service.tick();
      assert.equal((yield* store.read()).pending[0]?.attempts, 1);
      assert.equal((yield* service.getState({ threadId })).entries.length, 0);
      yield* service.tick();
      assert.equal(calls, 1);
      yield* TestClock.adjust("2 minutes");
      yield* service.tick();
      assert.equal((yield* store.read()).pending.length, 0);
      assert.equal((yield* service.getState({ threadId })).entries.length, 1);
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect(
    "retains concurrent explicit memory and never resurrects forgotten evidence from a running dream",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const { service } = yield* setup((input) =>
          input.mode === "dream"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(finish);
                return resultFor(input);
              })
            : Effect.succeed(resultFor(input)),
        );
        yield* TestClock.adjust("10 minutes");
        yield* service.tick();
        yield* TestClock.adjust("7 days");
        yield* service.tick();
        const worker = yield* service.tick().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const learned = (yield* service.getState({ threadId })).entries[0]!;
        yield* service.forget({ id: learned.id });
        const explicit = yield* service.upsert({
          projectId,
          title: "Explicit decision",
          text: "Keep the user's new decision.",
          pinned: false,
        });
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(worker);
        assert.deepEqual(
          (yield* service.getState({ threadId })).entries.map((entry) => entry.id),
          [explicit.id],
        );
        yield* service.tick();
        assert.deepEqual(
          (yield* service.getState({ threadId })).entries.map((entry) => entry.id),
          [explicit.id],
        );
      }).pipe(Effect.provide(dependencies())),
  );

  it.effect("honors separate per-thread recall and generation controls", () =>
    Effect.gen(function* () {
      const inputs: MemoryGenerationInput[] = [];
      const { service } = yield* setup((input) =>
        Effect.sync(() => {
          inputs.push(input);
          return resultFor(input);
        }),
      );
      yield* service.setThreadPolicy({ threadId, useMemories: false, generateMemories: false });
      yield* service.upsert({
        projectId,
        title: "Existing memory",
        text: "A remembered decision.",
        pinned: true,
      });
      yield* TestClock.adjust("10 minutes");
      yield* service.tick();
      assert.deepEqual(inputs, []);
      assert.equal(yield* service.contextForThread(threadId, "decision"), "");
      assert.equal((yield* Effect.flip(service.forAgent(threadId)))._tag, "MemoryError");
      yield* service.setThreadPolicy({ threadId, useMemories: true, generateMemories: true });
      yield* service.tick();
      assert.include(yield* service.contextForThread(threadId, "decision"), "remembered decision");
      assert.deepEqual(inputs, []);
      yield* insertCompletedTurns(threadId, 1);
      yield* service.tick();
      assert.deepEqual(
        inputs.map((input) => input.mode),
        ["extract"],
      );
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect("finishes daily batches instead of marking an oversized scope complete early", () =>
    Effect.gen(function* () {
      const consolidationInputs: MemoryGenerationInput[] = [];
      const { service } = yield* setup((input) => {
        if (input.mode === "consolidate") {
          consolidationInputs.push(input);
          return Effect.succeed(resultFor(input));
        }
        return Effect.succeed({
          entries: Array.from({ length: 8 }, (_, index) => ({
            ...resultFor(input).entries[0]!,
            title: `Decision ${index}`,
            text: `Confirmed decision ${index}.`,
          })),
        });
      });
      yield* insertCompletedThreads(7);
      yield* TestClock.adjust("10 minutes");
      yield* service.tick();
      yield* service.tick();
      yield* TestClock.adjust("24 hours");
      yield* service.tick();
      assert.equal(consolidationInputs[0]?.sources.length, 32);
      assert.equal((yield* service.getState({ threadId })).entries.length, 33);
      yield* service.tick();
      assert.equal(consolidationInputs[1]?.sources.length, 32);
      const firstIds = new Set(consolidationInputs[0]!.sources.map((source) => source.id));
      assert.isTrue(consolidationInputs[1]!.sources.every((source) => !firstIds.has(source.id)));
      assert.equal((yield* service.getState({ threadId })).entries.length, 2);
      yield* service.tick();
      assert.equal(consolidationInputs.length, 2);
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect(
    "queues manual maintenance while a user turn is active and resumes when it settles",
    () =>
      Effect.gen(function* () {
        const inputs: MemoryGenerationInput[] = [];
        const { service, store } = yield* setup((input) =>
          Effect.sync(() => {
            inputs.push(input);
            return resultFor(input);
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES (${threadId}, 'new-turn', 'running', ${sourceTime}, '[]')`;
        yield* TestClock.adjust("10 minutes");
        yield* service.runNow({});
        yield* service.tick();
        assert.deepEqual(inputs, []);
        assert.isTrue((yield* store.read()).runRequested);
        yield* sql`UPDATE projection_turns SET state = 'completed', completed_at = ${sourceTime} WHERE turn_id = 'new-turn'`;
        yield* service.tick();
        yield* service.tick();
        yield* service.tick();
        assert.deepEqual(
          inputs.map((input) => input.mode),
          ["extract", "consolidate", "dream"],
        );
        assert.isFalse((yield* store.read()).runRequested);
      }).pipe(Effect.provide(dependencies())),
  );

  it.effect("preserves an explicit memory added during extraction", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const { service } = yield* setup((input) =>
        Effect.gen(function* () {
          if (input.mode === "extract") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
          }
          return resultFor(input);
        }),
      );
      yield* TestClock.adjust("10 minutes");
      const worker = yield* service.tick().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const explicit = yield* service.upsert({
        projectId,
        title: "Current decision",
        text: "Keep this exact explicit decision.",
        pinned: false,
      });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(worker);
      const state = yield* service.getState({ threadId });
      assert.deepEqual(
        state.entries.map((entry) => entry.id),
        [explicit.id],
      );
      assert.equal(state.status.pendingSources, 1);
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect("does not publish model partials while extraction is running", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const { service } = yield* setup((input) =>
        Effect.gen(function* () {
          if (input.mode === "extract") {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(finish);
          }
          return resultFor(input);
        }),
      );
      yield* TestClock.adjust("10 minutes");
      const worker = yield* service.tick().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.equal((yield* service.getState({ threadId })).entries.length, 0);
      yield* service.setThreadPolicy({ threadId, useMemories: true, generateMemories: false });
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(worker);
      assert.equal((yield* service.getState({ threadId })).entries.length, 0);
    }).pipe(Effect.provide(dependencies())),
  );

  it.effect("retains a multi-source memory while another valid citation remains", () =>
    Effect.gen(function* () {
      const { service, store, reader } = yield* setup((input) => Effect.succeed(resultFor(input)));
      yield* insertCompletedThreads(1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* reader.discoverChats({ at: "", rowId: 0 }, sourceTime, 10);
      const sources = rows.map((row) => ({
        id: Sources.sourceId(row),
        revision: Sources.sourceRevision(row),
        at: row.at,
        rowId: row.rowId,
        threadId: row.threadId,
        turnId: row.turnId,
        projectId: row.projectId,
        kind: "conversation" as const,
        attempts: 0,
        retryAt: "",
      }));
      const metadata = yield* store.writeEntry({
        ...resultFor({
          cwd: "",
          modelSelection: DEFAULT_MEMORY_SETTINGS.modelSelection,
          mode: "consolidate",
          sources: sources.map((source) => ({ id: source.id, text: "evidence" })),
        }).entries[0]!,
        id: "multi-source",
        projectId,
        sourceIds: sources.map((source) => source.id),
        pinned: false,
        createdAt: sourceTime,
        updatedAt: sourceTime,
      });
      yield* store.update((current) =>
        Effect.succeed({
          manifest: {
            ...current,
            entries: [metadata],
            sources: Object.fromEntries(sources.map((source) => [source.id, source])),
          },
          result: undefined,
        }),
      );

      yield* sql`UPDATE projection_threads SET deleted_at = '1970-01-01T00:00:01.000Z'
        WHERE thread_id = ${threadId}`;
      yield* service.tick();
      const retained = (yield* service.getState({ projectId })).entries[0]!;
      assert.deepEqual(retained.sourceIds, ["history-thread-0/history-turn-0"]);

      yield* sql`UPDATE projection_threads SET deleted_at = '1970-01-01T00:00:02.000Z'
        WHERE thread_id = 'history-thread-0'`;
      yield* service.tick();
      assert.deepEqual((yield* service.getState({ projectId })).entries, []);
    }).pipe(Effect.provide(dependencies())),
  );
});
