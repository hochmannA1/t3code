import * as NodeCrypto from "node:crypto";
import {
  MemoryError,
  MemoryEntry,
  type MemoryForgetInput,
  type MemorySetThreadPolicyInput,
  type MemoryState,
  type MemoryStateInput,
  type MemoryUpsertInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { buildMemoryContext } from "./MemoryContext.ts";
import { redactMemoryText } from "./redactMemoryText.ts";
import { MemorySourceReader, sourceId, sourceRevision, sourceText } from "./MemorySourceReader.ts";
import { MemoryStore, fingerprint, type MemoryManifest, type MemorySource } from "./MemoryStore.ts";

const DEFAULT_THREAD_POLICY = { useMemories: true, generateMemories: true };
const MAX_AUTOMATIC_ENTRIES_PER_SCOPE = 512;
const MAX_EXTRACTED_ENTRIES = 8;
const MAX_MAINTENANCE_ENTRIES = 24;
const MAX_SOURCE_ATTEMPTS = 5;
const DAILY_CONSOLIDATION_MS = 24 * 60 * 60_000;
const WEEKLY_DREAM_MS = 7 * DAILY_CONSOLIDATION_MS;
const iso = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(MemoryEntry));
const scopeKey = (projectId: ProjectId | null) => projectId ?? "__personal__";
const digestEntries = (entries: ReadonlyArray<MemoryEntry>) =>
  fingerprint(
    JSON.stringify(
      entries.map(({ id, text, title, sourceIds, updatedAt }) => ({
        id,
        text,
        title,
        sourceIds,
        updatedAt,
      })),
    ),
  );
const messageFrom = (error: unknown) => {
  if (error && typeof error === "object" && "detail" in error && typeof error.detail === "string")
    return redactMemoryText(error.detail).slice(0, 500);
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return redactMemoryText(error.message).slice(0, 500);
  return "Memory maintenance failed. The pending work will be retried.";
};

export const make = Effect.gen(function* () {
  const store = yield* MemoryStore;
  const reader = yield* MemorySourceReader;
  const settings = yield* ServerSettingsService;
  const generation = yield* TextGeneration;
  const config = yield* ServerConfig;
  const now = Clock.currentTimeMillis.pipe(Effect.map(iso));

  const policy = (manifest: MemoryManifest, threadId?: string) =>
    (threadId ? manifest.threadPolicies[threadId] : undefined) ?? DEFAULT_THREAD_POLICY;

  const scopedEntries = Effect.fn("MemoryService.scopedEntries")(function* (
    manifest: MemoryManifest,
    projectId?: ProjectId,
  ) {
    const candidates = manifest.entries.filter(
      (entry) =>
        projectId === undefined || entry.projectId === null || entry.projectId === projectId,
    );
    const sourceIds = [...new Set(candidates.flatMap((entry) => entry.sourceIds))];
    const valid = yield* reader.validSourceIds(
      sourceIds.flatMap((id) => (manifest.sources[id] ? [manifest.sources[id]] : [])),
    );
    return yield* store.loadEntries(
      candidates.flatMap((entry) => {
        const sourceIds = entry.sourceIds.filter((id) => valid.has(id));
        return entry.sourceIds.length === 0 || sourceIds.length > 0
          ? [{ ...entry, sourceIds }]
          : [];
      }),
    );
  });

  const getState = Effect.fn("MemoryService.getState")(function* (
    input: MemoryStateInput,
  ): Effect.fn.Return<MemoryState, MemoryError> {
    const manifest = yield* store.read();
    const projectId = input.threadId
      ? yield* reader.projectForThread(input.threadId)
      : input.projectId;
    return {
      entries: yield* scopedEntries(manifest, projectId),
      threadPolicy: policy(manifest, input.threadId),
      status: {
        pendingSources: manifest.pending.length,
        failedSources: manifest.failed.length,
        backfillCompletedAt: manifest.backfillCompletedAt,
        lastConsolidatedAt: manifest.lastConsolidatedAt,
        lastDreamedAt: manifest.lastDreamedAt,
        lastError: manifest.lastError,
        running: yield* store.isRunning(yield* now),
        memoryDirectory: store.directory,
      },
    };
  });

  const upsert = Effect.fn("MemoryService.upsert")(function* (input: MemoryUpsertInput) {
    const timestamp = yield* now;
    const entry = yield* store.update((current) =>
      Effect.gen(function* () {
        const previous = input.id
          ? current.entries.find((entry) => entry.id === input.id)
          : undefined;
        if (input.id && !previous)
          return yield* new MemoryError({ message: "The memory no longer exists." });
        const result: MemoryEntry = {
          id: previous?.id ?? NodeCrypto.randomUUID(),
          projectId: input.projectId,
          title: input.title,
          text: input.text,
          keywords: input.keywords ?? previous?.keywords ?? [],
          sourceIds: previous?.sourceIds ?? [],
          pinned: input.pinned,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        const metadata = yield* store.writeEntry(result);
        return {
          manifest: {
            ...current,
            entries: [...current.entries.filter((entry) => entry.id !== result.id), metadata],
          },
          result,
        };
      }),
    );
    yield* store.publishIndex();
    return entry;
  });

  const forget = Effect.fn("MemoryService.forget")(function* ({ id }: MemoryForgetInput) {
    yield* store.update((current) =>
      Effect.sync(() => {
        const removed = current.entries.find((entry) => entry.id === id);
        const suppressed = new Set([...current.suppressedSources, ...(removed?.sourceIds ?? [])]);
        // Also remove derived siblings. Otherwise their next dream could recreate
        // the forgotten fact from the same retained conversation evidence.
        return {
          manifest: {
            ...current,
            entries: current.entries.filter(
              (entry) =>
                entry.id !== id && !entry.sourceIds.some((source) => suppressed.has(source)),
            ),
            pending: current.pending.filter((source) => !suppressed.has(source.id)),
            failed: current.failed.filter((source) => !suppressed.has(source.id)),
            suppressedSources: [...suppressed],
          },
          result: undefined,
        };
      }),
    );
    yield* store.publishIndex();
  });

  const setThreadPolicy = Effect.fn("MemoryService.setThreadPolicy")(function* (
    input: MemorySetThreadPolicyInput,
  ) {
    yield* reader.projectForThread(input.threadId);
    const result = { useMemories: input.useMemories, generateMemories: input.generateMemories };
    yield* store.update((current) =>
      Effect.succeed({
        manifest: {
          ...current,
          threadPolicies: { ...current.threadPolicies, [input.threadId]: result },
          pending: input.generateMemories
            ? current.pending
            : current.pending.filter((source) => source.threadId !== input.threadId),
          failed: input.generateMemories
            ? current.failed
            : current.failed.filter((source) => source.threadId !== input.threadId),
        },
        result: undefined,
      }),
    );
    return result;
  });

  const contextForThread = Effect.fn("MemoryService.contextForThread")(
    function* (threadId: ThreadId, query: string) {
      const preferences = (yield* settings.getSettings).memory;
      if (!preferences.enabled || !preferences.useMemories) return "";
      const manifest = yield* store.read();
      if (!policy(manifest, threadId).useMemories || manifest.entries.length === 0) return "";
      const projectId = yield* reader.projectForThread(threadId);
      const entries = yield* scopedEntries(manifest, projectId);
      return buildMemoryContext({
        query,
        entries,
        projectId,
        maxTokens: preferences.maxContextTokens,
      });
    },
    Effect.mapError((error) => new MemoryError({ message: messageFrom(error) })),
  );

  const forAgent = Effect.fn("MemoryService.forAgent")(
    function* (threadId: ThreadId) {
      const preferences = (yield* settings.getSettings).memory;
      const manifest = yield* store.read();
      if (
        !preferences.enabled ||
        !preferences.useMemories ||
        !policy(manifest, threadId).useMemories
      ) {
        return yield* new MemoryError({
          message: "Memory access is disabled for this thread or environment.",
        });
      }
      return yield* getState({ threadId });
    },
    Effect.mapError((error) => new MemoryError({ message: messageFrom(error) })),
  );

  const runNow = Effect.fn("MemoryService.runNow")(
    function* (_input: Record<string, never>) {
      const preferences = (yield* settings.getSettings).memory;
      if (!preferences.enabled)
        return yield* new MemoryError({ message: "Enable memory before running maintenance." });
      yield* store.update((current) =>
        Effect.succeed({
          manifest: {
            ...current,
            runRequested: true,
            lastError: null,
            consolidationRetryAt: "",
            dreamRetryAt: "",
            pending: [
              ...current.pending.map((source) => ({ ...source, retryAt: "" })),
              ...current.failed.map((source) => ({ ...source, attempts: 0, retryAt: "" })),
            ],
            failed: [],
          },
          result: undefined,
        }),
      );
    },
    Effect.mapError((error) => new MemoryError({ message: messageFrom(error) })),
  );

  const discover = Effect.fn("MemoryService.discover")(function* (cutoff: string) {
    const snapshot = yield* store.read();
    if (snapshot.pending.length >= 64) return;
    const rows = yield* snapshot.backfillCompletedAt === null
      ? reader.discoverChats(snapshot.cursor, cutoff, 64 - snapshot.pending.length)
      : reader.discover(snapshot.cursor, cutoff, 64 - snapshot.pending.length);
    if (!rows.length) {
      if (snapshot.pending.length === 0 && snapshot.backfillCompletedAt === null) {
        const timestamp = yield* now;
        yield* store.update((current) =>
          Effect.succeed({
            manifest: { ...current, backfillCompletedAt: timestamp },
            result: undefined,
          }),
        );
      }
      return;
    }
    yield* store.update((current) =>
      Effect.sync(() => {
        const pending = new Map(current.pending.map((source) => [source.id, source]));
        for (const row of rows) {
          const id = sourceId(row);
          const revision = sourceRevision(row);
          if (!policy(current, row.threadId).generateMemories) continue;
          if (current.suppressedSources.includes(id) || current.sources[id]?.revision === revision)
            continue;
          pending.set(id, {
            id,
            revision,
            at: row.at,
            rowId: row.rowId,
            threadId: row.threadId,
            turnId: row.turnId,
            projectId: row.projectId,
            kind: snapshot.backfillCompletedAt === null ? "conversation" : "turn",
            attempts: 0,
            retryAt: "",
          });
        }
        const last = rows.at(-1)!;
        return {
          manifest: {
            ...current,
            cursor: { at: last.at, rowId: last.rowId },
            pending: [...pending.values()],
          },
          result: undefined,
        };
      }),
    );
  });

  const removePending = (source: MemorySource) =>
    store.update((current) =>
      Effect.succeed({
        manifest: {
          ...current,
          pending: current.pending.filter(
            (job) => job.id !== source.id || job.revision !== source.revision,
          ),
        },
        result: undefined,
      }),
    );

  const extract = Effect.fn("MemoryService.extract")(function* (
    source: MemorySource,
    owner: string,
  ) {
    const manifest = yield* store.read();
    if (manifest.suppressedSources.includes(source.id)) return yield* removePending(source);
    if (!policy(manifest, source.threadId).generateMemories) return;
    const row = yield* reader.read(source);
    if (!row) return yield* removePending(source);
    if (row.active) return;
    const revision = sourceRevision(row);
    if (revision !== source.revision) {
      yield* store.update((current) =>
        Effect.succeed({
          manifest: {
            ...current,
            pending: current.pending.map((job) =>
              job.id === source.id
                ? { ...job, revision, at: row.at, attempts: 0, retryAt: "" }
                : job,
            ),
          },
          result: undefined,
        }),
      );
      return;
    }
    const preferences = (yield* settings.getSettings).memory;
    if (!preferences.enabled || !preferences.generateMemories) return;
    yield* store.loadEntries(
      manifest.entries.filter((entry) => entry.sourceIds.includes(source.id)),
    );
    const evidence =
      source.kind === "conversation" ? yield* reader.readConversation(source) : sourceText(row);
    const generated = yield* generation
      .generateMemory({
        cwd: config.stateDir,
        modelSelection: preferences.modelSelection,
        mode: "extract",
        sources: [{ id: source.id, text: evidence }],
      })
      .pipe(Effect.timeout("90 seconds"));
    if (generated.entries.length > MAX_EXTRACTED_ENTRIES)
      return yield* new MemoryError({
        message: `Memory extraction returned more than ${MAX_EXTRACTED_ENTRIES} entries.`,
      });
    const timestamp = yield* now;
    const latestSettings = (yield* settings.getSettings).memory;
    const latest = yield* reader.read(source);
    if (
      !latestSettings.enabled ||
      !latestSettings.generateMemories ||
      !latest ||
      sourceRevision(latest) !== revision
    )
      return;
    yield* store.update((current) =>
      Effect.gen(function* () {
        if (
          !(yield* store.ownsLease(owner, timestamp)) ||
          current.revision !== manifest.revision ||
          current.suppressedSources.includes(source.id) ||
          !policy(current, source.threadId).generateMemories ||
          current.sources[source.id]?.revision === revision
        )
          return { manifest: current, result: undefined };
        const retained = current.entries.filter(
          (entry) => entry.pinned || !entry.sourceIds.includes(source.id),
        );
        const learnedCounts = new Map<string, number>();
        for (const entry of retained) {
          if (entry.pinned || entry.sourceIds.length === 0) continue;
          const key = scopeKey(entry.projectId);
          learnedCounts.set(key, (learnedCounts.get(key) ?? 0) + 1);
        }
        for (const entry of generated.entries) {
          const key = scopeKey(entry.scope === "personal" ? null : source.projectId);
          learnedCounts.set(key, (learnedCounts.get(key) ?? 0) + 1);
        }
        if (
          current.backfillCompletedAt !== null &&
          [...learnedCounts.values()].some((count) => count > MAX_AUTOMATIC_ENTRIES_PER_SCOPE)
        ) {
          return yield* new MemoryError({
            message:
              "This memory scope is full. Pending extraction will resume after consolidation.",
          });
        }
        const additions = yield* Effect.forEach(generated.entries, (entry) =>
          store.writeEntry({
            ...entry,
            title: redactMemoryText(entry.title),
            text: redactMemoryText(entry.text),
            keywords: entry.keywords.map(redactMemoryText),
            id: NodeCrypto.randomUUID(),
            projectId: entry.scope === "personal" ? null : source.projectId,
            sourceIds: [source.id],
            pinned: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
        return {
          manifest: {
            ...current,
            entries: [...retained, ...additions],
            sources: { ...current.sources, [source.id]: source },
            pending: current.pending.filter(
              (job) => job.id !== source.id || job.revision !== revision,
            ),
            lastError: null,
          },
          result: undefined,
        };
      }),
    );
  });

  const maintain = Effect.fn("MemoryService.maintain")(function* (
    owner: string,
    mode: "consolidate" | "dream",
    force: boolean,
  ) {
    const preferences = (yield* settings.getSettings).memory;
    if (!preferences.enabled || (!preferences.dreaming && !force)) return true;
    const current = yield* store.read();
    const timestamp = yield* now;
    if (yield* reader.hasActiveTurns(iso(Date.parse(timestamp) - preferences.idleMinutes * 60_000)))
      return false;
    const weekly = mode === "dream";
    const lastCompletedAt = weekly ? current.lastDreamedAt : current.lastConsolidatedAt;
    const retryAt = weekly ? current.dreamRetryAt : current.consolidationRetryAt;
    const interval = weekly ? WEEKLY_DREAM_MS : DAILY_CONSOLIDATION_MS;
    const baseline = lastCompletedAt ?? current.maintenanceStartedAt;
    if (!force && retryAt > timestamp) return true;
    if (!force && !weekly && baseline && Date.parse(timestamp) - Date.parse(baseline) < interval)
      return true;
    if (
      weekly &&
      current.dreamCycleStartedAt === null &&
      !force &&
      baseline &&
      Date.parse(timestamp) - Date.parse(baseline) < interval
    )
      return true;
    if (weekly && current.dreamCycleStartedAt === null) {
      yield* store.update((latest) =>
        Effect.succeed({
          manifest: {
            ...latest,
            dreamCycleStartedAt: timestamp,
            dreamedScopes: {},
          },
          result: undefined,
        }),
      );
      return false;
    }
    const progress = weekly ? current.dreamedScopes : current.consolidatedScopes;
    const all = yield* store.loadEntries(current.entries);
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of all) {
      if (entry.pinned || entry.sourceIds.length === 0) continue;
      const key = scopeKey(entry.projectId);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, group] of [...groups].sort(
      (left, right) => right[1].length - left[1].length,
    )) {
      const before = digestEntries(group);
      if (progress[key] === before || group.length === 0) continue;
      // A maintenance call replaces exactly its bounded input batch and retains all other notes.
      const selected: MemoryEntry[] = [];
      let characters = 0;
      const unprocessed = (entry: MemoryEntry) =>
        progress[`entry:${entry.id}`] !== fingerprint(encodeEntry(entry));
      const ordered = group.toSorted((a, b) => Number(unprocessed(b)) - Number(unprocessed(a)));
      for (const entry of ordered) {
        if (!unprocessed(entry)) continue;
        const length = encodeEntry(entry).length;
        if (selected.length >= 32 || characters + length > 80_000) break;
        selected.push(entry);
        characters += length;
      }
      if (selected.length === 0) {
        const otherPending = [...groups].some(
          ([otherKey, otherGroup]) =>
            otherKey !== key && progress[otherKey] !== digestEntries(otherGroup),
        );
        yield* store.update((latest) =>
          Effect.succeed({
            manifest: {
              ...latest,
              ...(weekly
                ? {
                    dreamedScopes: { ...latest.dreamedScopes, [key]: before },
                    ...(otherPending
                      ? {}
                      : { dreamCycleStartedAt: null, lastDreamedAt: timestamp }),
                  }
                : {
                    consolidatedScopes: { ...latest.consolidatedScopes, [key]: before },
                    ...(otherPending ? {} : { lastConsolidatedAt: timestamp }),
                  }),
            },
            result: undefined,
          }),
        );
        return !otherPending;
      }
      const generated = yield* generation
        .generateMemory({
          cwd: config.stateDir,
          modelSelection: preferences.modelSelection,
          mode,
          sources: selected.map((entry) => ({ id: entry.id, text: encodeEntry(entry) })),
        })
        .pipe(Effect.timeout("90 seconds"));
      if (generated.entries.length > MAX_MAINTENANCE_ENTRIES)
        return yield* new MemoryError({
          message: `Memory maintenance returned more than ${MAX_MAINTENANCE_ENTRIES} entries.`,
        });
      const completedAt = yield* now;
      const latestSettings = (yield* settings.getSettings).memory;
      if (!latestSettings.enabled || (!latestSettings.dreaming && !force)) return false;
      const selectedIds = new Set(selected.map((entry) => entry.id));
      yield* store.update((latest) =>
        Effect.gen(function* () {
          if (!(yield* store.ownsLease(owner, completedAt)) || latest.revision !== current.revision)
            return { manifest: latest, result: undefined };
          const retained = latest.entries.filter((entry) => !selectedIds.has(entry.id));
          const additions = yield* Effect.forEach(generated.entries, (entry) => {
            const sourceIds = [
              ...new Set(
                entry.sourceIds.flatMap(
                  (id) => selected.find((source) => source.id === id)?.sourceIds ?? [],
                ),
              ),
            ];
            return store.writeEntry({
              ...entry,
              title: redactMemoryText(entry.title),
              text: redactMemoryText(entry.text),
              keywords: entry.keywords.map(redactMemoryText),
              id: NodeCrypto.randomUUID(),
              projectId: selected[0]!.projectId,
              sourceIds,
              pinned: false,
              createdAt: completedAt,
              updatedAt: completedAt,
            });
          });
          const after = yield* store.loadEntries(
            [...retained, ...additions].filter(
              (entry) =>
                !entry.pinned && entry.sourceIds.length > 0 && scopeKey(entry.projectId) === key,
            ),
          );
          const cleanProgress = (value: Record<string, string>) =>
            Object.fromEntries(
              Object.entries(value).filter(
                ([name]) => !name.startsWith("entry:") || !selectedIds.has(name.slice(6)),
              ),
            );
          const processed = cleanProgress(
            weekly ? latest.dreamedScopes : latest.consolidatedScopes,
          );
          const otherProcessed = cleanProgress(
            weekly ? latest.consolidatedScopes : latest.dreamedScopes,
          );
          for (const entry of after.filter((entry) =>
            additions.some((addition) => addition.id === entry.id),
          )) {
            const fingerprintValue = fingerprint(encodeEntry(entry));
            processed[`entry:${entry.id}`] = fingerprintValue;
            otherProcessed[`entry:${entry.id}`] = fingerprintValue;
          }
          const complete = after.every(
            (entry) => processed[`entry:${entry.id}`] === fingerprint(encodeEntry(entry)),
          );
          return {
            manifest: {
              ...latest,
              entries: [...retained, ...additions],
              ...(weekly
                ? {
                    dreamedScopes: { ...processed, [key]: complete ? digestEntries(after) : "" },
                    consolidatedScopes: { ...otherProcessed, [key]: "" },
                    dreamRetryAt: "",
                  }
                : {
                    consolidatedScopes: {
                      ...processed,
                      [key]: complete ? digestEntries(after) : "",
                    },
                    dreamedScopes: { ...otherProcessed, [key]: "" },
                    consolidationRetryAt: "",
                  }),
              lastError: null,
            },
            result: undefined,
          };
        }),
      );
      return false;
    }
    yield* store.update((latest) =>
      Effect.succeed({
        manifest: {
          ...latest,
          ...(weekly
            ? {
                dreamCycleStartedAt: null,
                lastDreamedAt: timestamp,
                dreamRetryAt: "",
              }
            : {
                lastConsolidatedAt: timestamp,
                consolidationRetryAt: "",
              }),
          lastError: null,
        },
        result: undefined,
      }),
    );
    return true;
  });

  const pruneDeletedSources = Effect.fn("MemoryService.pruneDeletedSources")(function* () {
    const current = yield* store.read();
    const referenced = new Set(current.entries.flatMap((entry) => entry.sourceIds));
    const valid = yield* reader.validSourceIds(
      [...referenced].flatMap((id) => (current.sources[id] ? [current.sources[id]] : [])),
    );
    const missing = new Set([...referenced].filter((id) => !valid.has(id)));
    if (missing.size)
      yield* store.update((latest) =>
        Effect.succeed({
          manifest: {
            ...latest,
            entries: latest.entries.flatMap((entry) => {
              const sourceIds = entry.sourceIds.filter((id) => !missing.has(id));
              return entry.sourceIds.length === 0 || sourceIds.length > 0
                ? [{ ...entry, sourceIds }]
                : [];
            }),
            suppressedSources: [...new Set([...latest.suppressedSources, ...missing])],
            pending: latest.pending.filter((source) => !missing.has(source.id)),
            failed: latest.failed.filter((source) => !missing.has(source.id)),
          },
          result: undefined,
        }),
      );
  });

  const tick = Effect.fn("MemoryService.tick")(
    function* () {
      const preferences = (yield* settings.getSettings).memory;
      if (!preferences.enabled) return;
      const started = yield* Clock.currentTimeMillis;
      if (yield* reader.hasActiveTurns(iso(started - preferences.idleMinutes * 60_000))) return;
      const owner = NodeCrypto.randomUUID();
      if (!(yield* store.acquire(owner, iso(started), iso(started + 10 * 60_000)))) return;
      yield* Effect.gen(function* () {
        const initial = yield* store.read();
        if (initial.maintenanceStartedAt === null || initial.backfillStartedAt === null)
          yield* store.update((latest) =>
            Effect.succeed({
              manifest: {
                ...latest,
                maintenanceStartedAt: latest.maintenanceStartedAt ?? iso(started),
                backfillStartedAt: latest.backfillStartedAt ?? iso(started),
              },
              result: undefined,
            }),
          );
        yield* pruneDeletedSources();
        if (preferences.generateMemories) {
          yield* discover(iso(started - preferences.idleMinutes * 60_000));
          const snapshot = yield* store.read();
          let count = 0;
          for (const job of snapshot.pending) {
            if (count >= preferences.maxSourcesPerPass) break;
            if (
              yield* reader.hasActiveTurns(
                iso((yield* Clock.currentTimeMillis) - preferences.idleMinutes * 60_000),
              )
            )
              break;
            if (job.retryAt > iso(started)) continue;
            if (!policy(snapshot, job.threadId).generateMemories) continue;
            count++;
            const succeeded = yield* extract(job, owner).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                store.update((latest) =>
                  Effect.sync(() => {
                    const attempt = job.attempts + 1;
                    const quarantined = attempt >= MAX_SOURCE_ATTEMPTS;
                    const updated = {
                      ...job,
                      attempts: attempt,
                      retryAt: quarantined
                        ? ""
                        : iso(
                            started + Math.min(3_600_000, 60_000 * 2 ** Math.min(job.attempts, 6)),
                          ),
                    };
                    return {
                      manifest: {
                        ...latest,
                        lastError: messageFrom(error),
                        pending: quarantined
                          ? latest.pending.filter((source) => source.id !== job.id)
                          : latest.pending.map((source) =>
                              source.id === job.id ? updated : source,
                            ),
                        failed: quarantined
                          ? [...latest.failed.filter((source) => source.id !== job.id), updated]
                          : latest.failed,
                      },
                      result: false,
                    };
                  }),
                ),
              ),
            );
            if (!succeeded) continue;
          }
        }
        if (yield* reader.hasActiveTurns()) {
          yield* store.publishIndex();
          return;
        }
        const snapshot = yield* store.read();
        const learnedByScope = new Map<string, number>();
        for (const entry of snapshot.entries) {
          if (entry.pinned || entry.sourceIds.length === 0) continue;
          const key = scopeKey(entry.projectId);
          learnedByScope.set(key, (learnedByScope.get(key) ?? 0) + 1);
        }
        const memoryNeedsRoom = [...learnedByScope.values()].some(
          (count) => count >= MAX_AUTOMATIC_ENTRIES_PER_SCOPE,
        );
        const consolidationComplete = yield* maintain(
          owner,
          "consolidate",
          snapshot.runRequested || memoryNeedsRoom,
        ).pipe(
          Effect.catch((error) =>
            store.update((latest) =>
              Effect.succeed({
                manifest: {
                  ...latest,
                  lastError: messageFrom(error),
                  consolidationRetryAt: iso(started + DAILY_CONSOLIDATION_MS),
                },
                result: false,
              }),
            ),
          ),
        );
        const dreamComplete = yield* maintain(owner, "dream", snapshot.runRequested).pipe(
          Effect.catch((error) =>
            store.update((latest) =>
              Effect.succeed({
                manifest: {
                  ...latest,
                  lastError: messageFrom(error),
                  dreamRetryAt: iso(started + WEEKLY_DREAM_MS),
                },
                result: false,
              }),
            ),
          ),
        );
        if (snapshot.runRequested && consolidationComplete && dreamComplete)
          yield* store.update((latest) =>
            Effect.succeed({ manifest: { ...latest, runRequested: false }, result: undefined }),
          );
        yield* store.publishIndex();
      }).pipe(
        Effect.timeout("8 minutes"),
        Effect.ensuring(store.release(owner).pipe(Effect.orDie)),
      );
    },
    Effect.mapError((error) => new MemoryError({ message: messageFrom(error) })),
  );

  return { getState, upsert, forget, setThreadPolicy, contextForThread, forAgent, runNow, tick };
});

export class MemoryService extends Context.Service<MemoryService, Effect.Success<typeof make>>()(
  "t3/memory/MemoryService",
) {}
export const layer = Layer.effect(MemoryService, make);
