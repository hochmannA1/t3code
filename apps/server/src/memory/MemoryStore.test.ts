import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, type MemoryEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { make, recommendationMemoryDigest, type MemorySource } from "./MemoryStore.ts";

const remembered: MemoryEntry = {
  id: "memory-one",
  projectId: ProjectId.make("project-one"),
  title: "Deployment",
  text: "Use the persistent volume for workspace state.",
  keywords: ["deployment"],
  sourceIds: ["thread-one/turn-one"],
  pinned: false,
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};
const source: MemorySource = {
  id: "thread-one/turn-one",
  threadId: ThreadId.make("thread-one"),
  turnId: "turn-one",
  projectId: ProjectId.make("project-one"),
  kind: "turn",
  revision: "revision-one",
  at: "2026-09-04T10:00:00.000Z",
  rowId: 1,
  attempts: 1,
  retryAt: "2026-09-04T10:01:00.000Z",
};

function openStore<A, E>(
  baseDir: string,
  body: (
    store: Effect.Success<typeof make>,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>,
) {
  return Effect.gen(function* () {
    yield* runMigrations();
    return yield* body(yield* make);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: `${baseDir}/state.sqlite` }),
        ServerConfig.layerTest(process.cwd(), baseDir),
      ),
    ),
  );
}

describe("MemoryStore persistence", () => {
  it.effect("decodes manifests written before recommendation caching existed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-legacy-cache-" });
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const legacy =
            '{"version":1,"revision":0,"cursor":{"at":"","rowId":0},"entries":[],"pending":[],"sources":{},"suppressedSources":[],"threadPolicies":{},"dreamedScopes":{},"lastDreamedAt":null,"lastError":null,"runRequested":false,"recommendationCache":{"old-key":{"recommendations":[]}}}';
          yield* sql`UPDATE t3_memory_state SET manifest_json = ${legacy} WHERE id = 1`;
          assert.deepEqual((yield* store.read()).recommendationCache, {});
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("persists derived recommendations without changing the memory revision", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-cache-revision-" });
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const before = yield* store.read();
          const result = {
            recommendations: [
              {
                id: "memory-cache-test",
                type: "task" as const,
                label: "Review storage",
                prompt: "Review the current storage setup.",
              },
            ],
          };
          yield* store.cacheRecommendations(
            "freshness-key",
            null,
            recommendationMemoryDigest([], null),
            { ...result, retryable: false },
          );
          const after = yield* store.read();
          assert.equal(after.revision, before.revision);
          assert.deepEqual(after.recommendationCache["freshness-key"], {
            projectId: null,
            result: { ...result, retryable: false },
          });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reopens committed memory and pending work after an interrupted processing lease", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-restart-" });
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const metadata = yield* store.writeEntry(remembered);
          yield* store.update((current) =>
            Effect.succeed({
              manifest: {
                ...current,
                entries: [metadata],
                pending: [source],
                cursor: { at: source.at, rowId: 1 },
              },
              result: undefined,
            }),
          );
          assert.isTrue(
            yield* store.acquire("stopped-process", "2026-09-04T10:00:00Z", "2026-09-04T10:02:00Z"),
          );
        }),
      );
      // The first SQLite layer has closed. This opens the persisted file in a new store instance.
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const manifest = yield* store.read();
          assert.deepEqual(manifest.pending, [source]);
          assert.deepEqual(yield* store.loadEntries(manifest.entries), [remembered]);
          assert.isFalse(
            yield* store.acquire("new-process", "2026-09-04T10:01:00Z", "2026-09-04T10:03:00Z"),
          );
          assert.isTrue(
            yield* store.acquire("new-process", "2026-09-04T10:03:00Z", "2026-09-04T10:05:00Z"),
          );
          yield* store.release("stopped-process");
          assert.isTrue(yield* store.ownsLease("new-process", "2026-09-04T10:04:00Z"));
          yield* store.publishIndex();
          assert.include(yield* fs.readFileString(`${store.directory}/MEMORY.md`), "Deployment");
          assert.deepEqual(yield* store.loadEntries((yield* store.read()).entries), [remembered]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports changed or missing content without changing the file or manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-corrupt-" });
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const metadata = yield* store.writeEntry(remembered);
          yield* store.update((current) =>
            Effect.succeed({ manifest: { ...current, entries: [metadata] }, result: undefined }),
          );
          const original = yield* store.read();
          const filePath = `${store.directory}/notes/${metadata.file}`;
          yield* fs.writeFileString(filePath, "An external edit");
          assert.equal((yield* Effect.flip(store.loadEntry(metadata)))._tag, "MemoryError");
          assert.equal(yield* fs.readFileString(filePath), "An external edit");
          assert.deepEqual(yield* store.read(), original);
          yield* fs.remove(filePath);
          assert.equal((yield* Effect.flip(store.loadEntry(metadata)))._tag, "MemoryError");
          assert.isFalse(yield* fs.exists(filePath));
          assert.deepEqual(yield* store.read(), original);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a corrupt manifest instead of resetting saved processing state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-manifest-" });
      yield* openStore(baseDir, (store) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE t3_memory_state SET manifest_json = '{broken' WHERE id = 1`;
          assert.equal((yield* Effect.flip(store.read()))._tag, "MemoryError");
          assert.equal(
            (yield* Effect.flip(
              store.update((current) => Effect.succeed({ manifest: current, result: undefined })),
            ))._tag,
            "MemoryError",
          );
          assert.deepEqual(
            [...(yield* sql`SELECT manifest_json FROM t3_memory_state WHERE id = 1`)],
            [{ manifest_json: "{broken" }],
          );
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
