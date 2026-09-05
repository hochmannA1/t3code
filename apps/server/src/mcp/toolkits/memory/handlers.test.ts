import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemoryError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MemoryEntry,
  type MemoryUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { makeMemoryToolkitHandlers } from "./handlers.ts";

const projectId = ProjectId.make("current-project");
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("current-thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["memory"]),
  issuedAt: 1,
};
const entry = (
  id: string,
  project: ProjectId | null,
  text = "Receipts avoid polling.",
): MemoryEntry => ({
  id,
  projectId: project,
  title: "Receipts",
  text,
  keywords: ["worker"],
  sourceIds: ["thread/turn"],
  pinned: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

function fixture(path: Path.Path) {
  const state = {
    disabled: false,
    deletedThread: false,
    standalone: false,
    consulted: [] as ThreadId[],
    forgotten: [] as string[],
    saved: [] as MemoryUpsertInput[],
    entries: [
      entry("personal", null),
      entry("project", projectId),
      entry("foreign", ProjectId.make("other-project")),
    ],
  };
  const handlers = makeMemoryToolkitHandlers(
    {
      forAgent: (threadId, scope) => {
        state.consulted.push(threadId);
        return state.disabled
          ? Effect.fail(new MemoryError({ message: "Memory access is disabled." }))
          : Effect.succeed({
              entries: state.entries.filter(
                (entry) =>
                  scope === "all" ||
                  state.standalone ||
                  entry.projectId === null ||
                  entry.projectId === projectId,
              ),
              threadPolicy: { useMemories: true, generateMemories: true },
              status: {
                pendingSources: 0,
                failedSources: 0,
                backfillCompletedAt: null,
                lastConsolidatedAt: null,
                lastDreamedAt: null,
                lastError: null,
                running: false,
                memoryDirectory: "/memory",
              },
            });
      },
      upsert: (input) => {
        state.saved.push(input);
        return Effect.succeed({
          ...entry("saved", input.projectId, input.text),
          title: input.title,
          keywords: input.keywords ?? [],
          pinned: input.pinned,
        });
      },
      forget: ({ id }) => {
        state.forgotten.push(id);
        return Effect.void;
      },
    },
    {
      projectForThread: () =>
        state.deletedThread
          ? Effect.fail(new MemoryError({ message: "Thread no longer exists." }))
          : Effect.succeed(projectId),
    },
    path,
  );
  return { state, handlers };
}

it.effect(
  "search and read expose only current project and personal memory with bounded evidence",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture(yield* Path.Path);
      state.entries[1] = {
        ...entry("project", projectId, "x".repeat(1000) + " receipts " + "y".repeat(1000)),
        sourceIds: Array.from({ length: 40 }, (_, i) => `source-${i}`),
      };
      const matches = (yield* handlers.memory_search({ query: "receipts" })).matches;
      expect(matches.map((entry) => entry.id)).toEqual(["personal", "project"]);
      expect(matches.every((entry) => entry.snippet.length <= 500)).toBe(true);
      expect(matches[1]?.snippet).toContain("receipts");
      expect(matches[1]?.sourceIds).toHaveLength(32);
      expect(matches[1]?.sourcesTruncated).toBe(true);
      expect((yield* handlers.memory_search({ query: "no-match" })).matches).toEqual([]);
      const read = yield* handlers.memory_read({ id: "project" });
      expect(read.entry.text).toHaveLength(2010);
      expect(read.sourcesTruncated).toBe(true);
      expect(state.consulted.every((threadId) => threadId === invocation.threadId)).toBe(true);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);

it.effect("read and forget deny foreign IDs without mutating memory", () =>
  Effect.gen(function* () {
    const { state, handlers } = fixture(yield* Path.Path);
    const readError = yield* handlers.memory_read({ id: "foreign" }).pipe(Effect.flip);
    const forgetError = yield* handlers.memory_forget({ id: "foreign" }).pipe(Effect.flip);
    expect(readError.message).toContain("not found");
    expect(forgetError.message).toContain("not found");
    expect(state.forgotten).toEqual([]);
    yield* handlers.memory_forget({ id: "personal" });
    expect(state.forgotten).toEqual(["personal"]);
  }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);

it.effect(
  "remember derives project scope from the authenticated thread and pins explicit memories",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture(yield* Path.Path);
      yield* handlers.memory_remember({
        scope: "project",
        title: "Tests",
        text: "Wait for receipts.",
      });
      yield* handlers.memory_remember({
        scope: "personal",
        title: "Style",
        text: "Be concise.",
        keywords: ["writing"],
      });
      expect(state.saved).toEqual([
        { projectId, title: "Tests", text: "Wait for receipts.", keywords: [], pinned: true },
        {
          projectId: null,
          title: "Style",
          text: "Be concise.",
          keywords: ["writing"],
          pinned: true,
        },
      ]);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);

it.effect("capabilities and dynamic policies gate every operation, including writes", () =>
  Effect.gen(function* () {
    const { state, handlers } = fixture(yield* Path.Path);
    const error = yield* handlers.memory_search({ query: "receipts" }).pipe(
      Effect.provideService(McpInvocationContext, {
        ...invocation,
        capabilities: new Set<"memory">(),
      }),
      Effect.flip,
    );
    expect(error.message).toContain("unavailable");
    expect(state.consulted).toEqual([]);
    state.disabled = true;
    for (const operation of [
      handlers.memory_search({ query: "receipts", scope: "all" }).pipe(Effect.asVoid),
      handlers.memory_list({}).pipe(Effect.asVoid),
      handlers.memory_read({ id: "project" }).pipe(Effect.asVoid),
      handlers.memory_forget({ id: "project" }).pipe(Effect.asVoid),
      handlers
        .memory_remember({ scope: "project", title: "Tests", text: "Wait." })
        .pipe(Effect.asVoid),
    ]) {
      const failure = yield* operation.pipe(Effect.asVoid, Effect.flip);
      expect(failure.message).toContain("disabled");
    }
    expect(state.forgotten).toEqual([]);
    expect(state.saved).toEqual([]);
    state.disabled = false;
    state.deletedThread = true;
    expect(
      (yield* handlers.memory_search({ query: "receipts" }).pipe(Effect.flip)).message,
    ).toContain("no longer exists");
  }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);

it.effect(
  "explicit cross-project search and inventory reach all saved memories with pagination",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture(yield* Path.Path);
      state.entries = Array.from({ length: 55 }, (_, index) =>
        entry(`memory-${String(index).padStart(2, "0")}`, ProjectId.make(`project-${index}`)),
      );
      const first = yield* handlers.memory_list({ limit: 20 });
      expect(first.total).toBe(55);
      expect(first.nextOffset).toBe(20);
      expect(first.entries).toHaveLength(20);
      expect(first.indexPath).toBe("/memory/MEMORY.md");
      expect(first.status.pendingSources).toBe(0);
      const second = yield* handlers.memory_list({ limit: 20, offset: first.nextOffset! });
      const third = yield* handlers.memory_list({ limit: 20, offset: second.nextOffset! });
      expect(third.nextOffset).toBeNull();
      expect(
        new Set([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.id))
          .size,
      ).toBe(55);
      expect((yield* handlers.memory_list({ scope: "current" })).total).toBe(0);
      const search = yield* handlers.memory_search({
        query: "receipts",
        scope: "all",
        limit: 20,
        offset: 20,
      });
      expect(search.total).toBe(55);
      expect(search.nextOffset).toBe(40);
      expect(search.matches[0]?.id).toBe("memory-20");
      expect(search.matches[0]?.projectId).toBe(ProjectId.make("project-20"));
      expect((yield* handlers.memory_read({ id: "memory-20", scope: "all" })).entry.id).toBe(
        "memory-20",
      );
      const noMatches = yield* handlers.memory_search({ query: "invented query", scope: "all" });
      expect(noMatches.total).toBe(0);
      expect(noMatches.available).toBe(55);
      expect(noMatches.hint).toContain("memory_list");
    }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);

it.effect(
  "standalone default reads preserve the service's global scope without widening writes",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture(yield* Path.Path);
      state.standalone = true;
      expect((yield* handlers.memory_search({ query: "receipts" })).matches).toHaveLength(3);
      expect((yield* handlers.memory_read({ id: "foreign" })).entry.id).toBe("foreign");
      expect(
        (yield* handlers.memory_forget({ id: "foreign" }).pipe(Effect.flip)).message,
      ).toContain("not found");
      expect(state.forgotten).toEqual([]);
    }).pipe(Effect.provide(Path.layer), Effect.provideService(McpInvocationContext, invocation)),
);
