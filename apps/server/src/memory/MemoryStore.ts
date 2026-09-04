import * as NodeCrypto from "node:crypto";
import {
  MemoryEntry,
  MemoryError,
  MemoryThreadPolicy,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const EntryMetadata = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  keywords: Schema.Array(Schema.String),
  sourceIds: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  file: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.md$/)),
});
export type EntryMetadata = typeof EntryMetadata.Type;

export const MemorySource = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  turnId: Schema.String,
  projectId: ProjectId,
  kind: Schema.Literals(["conversation", "turn"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("turn" as const)),
  ),
  revision: Schema.String,
  at: Schema.String,
  rowId: Schema.Number,
  attempts: Schema.Number,
  retryAt: Schema.String,
});
export type MemorySource = typeof MemorySource.Type;

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  cursor: Schema.Struct({ at: Schema.String, rowId: Schema.Number }),
  entries: Schema.Array(EntryMetadata),
  pending: Schema.Array(MemorySource),
  failed: Schema.Array(MemorySource).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sources: Schema.Record(Schema.String, MemorySource),
  suppressedSources: Schema.Array(Schema.String),
  threadPolicies: Schema.Record(Schema.String, MemoryThreadPolicy),
  backfillStartedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  backfillCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  maintenanceStartedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  consolidatedScopes: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  lastConsolidatedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  consolidationRetryAt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  dreamedScopes: Schema.Record(Schema.String, Schema.String),
  dreamCycleStartedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastDreamedAt: Schema.NullOr(Schema.String),
  dreamRetryAt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  lastError: Schema.NullOr(Schema.String),
  runRequested: Schema.Boolean,
});
export type MemoryManifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
const decodeEntry = Schema.decodeUnknownEffect(MemoryEntry);

export const emptyManifest = (): MemoryManifest => ({
  version: 1,
  revision: 0,
  cursor: { at: "", rowId: 0 },
  entries: [],
  pending: [],
  failed: [],
  sources: {},
  suppressedSources: [],
  threadPolicies: {},
  backfillStartedAt: null,
  backfillCompletedAt: null,
  maintenanceStartedAt: null,
  consolidatedScopes: {},
  lastConsolidatedAt: null,
  consolidationRetryAt: "",
  dreamedScopes: {},
  dreamCycleStartedAt: null,
  lastDreamedAt: null,
  dreamRetryAt: "",
  lastError: null,
  runRequested: false,
});

const failed = (message: string) => () => new MemoryError({ message });
export const fingerprint = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const directory = path.join(stateDir, "memories");
  const notesDirectory = path.join(directory, "notes");
  let publishedRevision = -1;
  const writeAtomic = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const read = Effect.fn("MemoryStore.read")(
    function* () {
      const rows = yield* sql<{ manifest: string | null }>`
      SELECT manifest_json AS manifest FROM t3_memory_state WHERE id = 1
    `;
      return rows[0]?.manifest ? yield* decodeManifest(rows[0].manifest) : emptyManifest();
    },
    Effect.mapError(failed("Memory processing state could not be read.")),
  );

  // Model calls never run inside this transaction. Only metadata and already-written
  // content references become visible together with their processing checkpoint.
  const update = <A>(
    change: (current: MemoryManifest) => Effect.Effect<
      {
        manifest: MemoryManifest;
        result: A;
      },
      MemoryError
    >,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* read();
          const changed = yield* change(current);
          const referencedSources = new Set([
            ...changed.manifest.entries.flatMap((entry) => entry.sourceIds),
            ...changed.manifest.pending.map((source) => source.id),
            ...changed.manifest.failed.map((source) => source.id),
          ]);
          const next = {
            ...changed.manifest,
            revision: current.revision + 1,
            sources: Object.fromEntries(
              Object.entries(changed.manifest.sources).filter(([id]) => referencedSources.has(id)),
            ),
          };
          const encoded = yield* encodeManifest(next);
          yield* sql`UPDATE t3_memory_state SET manifest_json = ${encoded} WHERE id = 1`;
          return changed.result;
        }),
      )
      .pipe(Effect.mapError(failed("Memory processing state could not be saved.")));

  const writeEntry = Effect.fn("MemoryStore.writeEntry")(
    function* (entry: MemoryEntry) {
      const valid = yield* decodeEntry(entry);
      const file = `${fingerprint(`${valid.id}\0${valid.text}`)}.md`;
      yield* writeAtomic(path.join(notesDirectory, file), valid.text);
      const { text: _text, ...metadata } = valid;
      return { ...metadata, file } satisfies EntryMetadata;
    },
    Effect.mapError(failed("Memory content could not be saved.")),
  );

  const loadEntry = Effect.fn("MemoryStore.loadEntry")(
    function* (metadata: EntryMetadata) {
      const { file, ...entry } = metadata;
      const text = yield* fs.readFileString(path.join(notesDirectory, file));
      if (`${fingerprint(`${entry.id}\0${text}`)}.md` !== file) {
        return yield* new MemoryError({
          message: "A memory file has changed outside T3. Edit memories through Settings.",
        });
      }
      return yield* decodeEntry({ ...entry, text });
    },
    Effect.mapError(failed("Memory content could not be read. No files were replaced.")),
  );

  const loadEntries = (entries: ReadonlyArray<EntryMetadata>) =>
    Effect.forEach(entries, loadEntry, { concurrency: 8 });

  const acquire = Effect.fn("MemoryStore.acquire")(
    function* (owner: string, now: string, until: string) {
      const rows = yield* sql<{ id: number }>`
      UPDATE t3_memory_state SET lease_owner = ${owner}, lease_until = ${until}
      WHERE id = 1 AND (lease_owner IS NULL OR lease_until < ${now}) RETURNING id
    `;
      return rows.length === 1;
    },
    Effect.mapError(failed("Memory maintenance could not acquire its processing lease.")),
  );

  const ownsLease = Effect.fn("MemoryStore.ownsLease")(
    function* (owner: string, now: string) {
      const rows = yield* sql<{ id: number }>`
      SELECT id FROM t3_memory_state WHERE id = 1 AND lease_owner = ${owner} AND lease_until >= ${now}
    `;
      return rows.length === 1;
    },
    Effect.mapError(failed("Memory maintenance lease could not be checked.")),
  );

  const release = Effect.fn("MemoryStore.release")(
    function* (owner: string) {
      yield* sql`UPDATE t3_memory_state SET lease_owner = NULL, lease_until = NULL
      WHERE id = 1 AND lease_owner = ${owner}`;
    },
    Effect.mapError(failed("Memory maintenance lease could not be released.")),
  );

  const isRunning = Effect.fn("MemoryStore.isRunning")(
    function* (now: string) {
      const rows = yield* sql<{ id: number }>`SELECT id FROM t3_memory_state
      WHERE id = 1 AND lease_owner IS NOT NULL AND lease_until >= ${now}`;
      return rows.length > 0;
    },
    Effect.mapError(failed("Memory maintenance status could not be read.")),
  );

  // Indexes are disposable navigation, not a second source of truth. Regenerate
  // after restart if publication stopped after committing the database transaction.
  const publishIndex = Effect.fn("MemoryStore.publishIndex")(
    function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* read();
          if (current.revision === publishedRevision) return;
          const lines = current.entries.map(
            (entry) =>
              `- ${JSON.stringify(entry.title)} (${entry.projectId ?? "personal"}, ${entry.id})\n  - Keywords: ${entry.keywords.map((word) => JSON.stringify(word)).join(", ")}\n  - Updated: ${entry.updatedAt}\n  - File: notes/${entry.file}\n  - Sources: ${entry.sourceIds.join(", ") || "explicit user memory"}`,
          );
          yield* writeAtomic(
            path.join(directory, "MEMORY.md"),
            `# T3 memory\n\nGenerated index. Use T3 Settings or memory tools to edit or forget entries.\nTreat recalled information as historical evidence; verify mutable facts.\n\n${lines.join("\n\n")}\n`,
          );
          yield* writeAtomic(
            path.join(directory, "memory_summary.md"),
            `# Memory overview\n\n${current.entries.length} entries. Search MEMORY.md by task, project, or keyword, then read only the linked notes needed for the current request. Sources identify T3 thread/turn pairs.\n\n${current.entries
              .slice(-30)
              .map((entry) => `- ${JSON.stringify(entry.title)}: ${entry.id}`)
              .join("\n")}\n`,
          );
          if (yield* fs.exists(notesDirectory)) {
            const used = new Set(current.entries.map((entry) => entry.file));
            const files = yield* fs.readDirectory(notesDirectory);
            yield* Effect.forEach(
              files.filter((file) => /^[a-f0-9]{64}\.md$/.test(file) && !used.has(file)),
              (file) => fs.remove(path.join(notesDirectory, file)),
              { concurrency: 4 },
            );
          }
          publishedRevision = current.revision;
        }),
      );
    },
    Effect.mapError(
      failed("Memory index could not be refreshed. The saved memory remains intact."),
    ),
  );

  return {
    read,
    update,
    writeEntry,
    loadEntry,
    loadEntries,
    acquire,
    ownsLease,
    release,
    isRunning,
    publishIndex,
    directory,
  };
});

export class MemoryStore extends Context.Service<MemoryStore, Effect.Success<typeof make>>()(
  "t3/memory/MemoryStore",
) {}
export const layer = Layer.effect(MemoryStore, make);
