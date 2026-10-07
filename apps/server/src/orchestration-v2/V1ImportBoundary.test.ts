// @effect-diagnostics nodeBuiltinImport:off - Static architecture test scans source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const sourceRoot = NodePath.resolve(import.meta.dirname, "..");
const forbiddenImport =
  /from\s+["'][^"']*(?:ProviderService|ProviderSessionDirectory|ProviderSessionReaper|ProviderCommandReactor|ProviderRuntimeIngestion)[^"']*["']/;
// The V1 read model tables. `projection_projects` is not listed: it is the V2 project store.
const legacyTable =
  /\bprojection_(?:threads|thread_messages|thread_activities|thread_proposed_plans|thread_pull_requests|thread_sessions|turns|pending_approvals|state)\b/;
/** Directories whose files may read the V1 tables: the importer and the schema history. */
const legacyReaders = ["orchestration-v2/legacy/", "persistence/Migrations/"] as const;
/**
 * Individual files allowed to read the V1 tables, each with its reason. Keep this
 * list short; new V1 reads belong in the importer. The fork's historical
 * compatibility readers are read-only and do not restore the V1 runtime.
 */
const legacyReaderFiles: Record<string, string> = {
  // Provider history for settings migration reads V1 thread sessions once at load.
  "serverSettings.ts": "one-time provider history for settings migration",
  "memory/MemorySourceReader.ts":
    "read-only historical memory sources with stable legacy citations and cursors",
  "mcp/toolkits/threads/handlers.ts":
    "read-only imported transcripts whose legacy messages have no V2 run",
};
const retiredPaths = [
  "orchestration",
  "orchestration/Layers/ProviderCommandReactor.ts",
  "orchestration/Layers/ProviderRuntimeIngestion.ts",
  "orchestration/Services/ProviderCommandReactor.ts",
  "orchestration/Services/ProviderRuntimeIngestion.ts",
  "persistence/Services/ProjectionThreads.ts",
  "persistence/Services/ProjectionProjects.ts",
] as const;

function productionTypeScriptFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const relativeSources = productionTypeScriptFiles(sourceRoot).map((path) => ({
  path: NodePath.relative(sourceRoot, path).split(NodePath.sep).join("/"),
  source: NodeFS.readFileSync(path, "utf8"),
}));

it("keeps the V1 agent runtime and engine deleted", () => {
  for (const relativePath of retiredPaths) {
    assert.isFalse(NodeFS.existsSync(NodePath.join(sourceRoot, relativePath)), relativePath);
  }
  const violations = relativeSources
    .filter(({ path, source }) => !path.includes("/legacy/") && forbiddenImport.test(source))
    .map(({ path }) => path);
  assert.deepEqual(violations, []);
});

it("limits V1 table reads to the importer and documented compatibility readers", () => {
  const readers = relativeSources
    .filter(({ source }) => legacyTable.test(source))
    .map(({ path }) => path)
    .filter(
      (path) =>
        !legacyReaders.some((directory) => path.startsWith(directory)) &&
        legacyReaderFiles[path] === undefined,
    );
  assert.deepEqual(readers, []);
  // The allowlist must not outlive the reads it excuses.
  for (const path of Object.keys(legacyReaderFiles)) {
    const file = relativeSources.find((candidate) => candidate.path === path);
    assert.isTrue(file !== undefined && legacyTable.test(file.source), path);
  }
});

it("keeps the documented compatibility readers read-only for V1 tables", () => {
  const legacyMutation = new RegExp(
    String.raw`\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+[\x22\x60\[]?${legacyTable.source}`,
    "i",
  );
  for (const statement of [
    "UPDATE projection_threads SET title = ?",
    'INSERT OR IGNORE INTO "projection_thread_messages" VALUES (?)',
    "DELETE FROM projection_turns WHERE thread_id = ?",
    "REPLACE INTO projection_thread_sessions VALUES (?)",
  ]) {
    assert.isTrue(legacyMutation.test(statement), statement);
  }
  assert.isFalse(legacyMutation.test("SELECT * FROM projection_thread_messages"));
  for (const path of Object.keys(legacyReaderFiles)) {
    const file = relativeSources.find((candidate) => candidate.path === path);
    assert.isTrue(file !== undefined, path);
    assert.isFalse(legacyMutation.test(file!.source), path);
  }
});

it("keeps the legacy importer out of reach of new code", () => {
  const importers = relativeSources
    .filter(
      ({ path, source }) =>
        !path.startsWith("orchestration-v2/legacy/") && /from\s+["'][^"']*\/legacy\//.test(source),
    )
    .map(({ path }) => path)
    .toSorted();
  // Startup imports pending transcripts, the V2 runtime wires the importer, and
  // thread and project services hydrate a V1 transcript before they act on it.
  assert.deepEqual(importers, [
    "orchestration-v2/ThreadManagementService.ts",
    "orchestration-v2/runtimeLayer.ts",
    "project/ProjectService.ts",
    "serverRuntimeStartup.ts",
  ]);
});
