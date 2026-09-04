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

function fixture() {
  const state = {
    disabled: false,
    deletedThread: false,
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
      forAgent: (threadId) => {
        state.consulted.push(threadId);
        return state.disabled
          ? Effect.fail(new MemoryError({ message: "Memory access is disabled." }))
          : Effect.succeed({
              entries: state.entries,
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
  );
  return { state, handlers };
}

it.effect(
  "search and read expose only current project and personal memory with bounded evidence",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture();
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
    }).pipe(Effect.provideService(McpInvocationContext, invocation)),
);

it.effect("read and forget deny foreign IDs without mutating memory", () =>
  Effect.gen(function* () {
    const { state, handlers } = fixture();
    const readError = yield* handlers.memory_read({ id: "foreign" }).pipe(Effect.flip);
    const forgetError = yield* handlers.memory_forget({ id: "foreign" }).pipe(Effect.flip);
    expect(readError.message).toContain("not found");
    expect(forgetError.message).toContain("not found");
    expect(state.forgotten).toEqual([]);
    yield* handlers.memory_forget({ id: "personal" });
    expect(state.forgotten).toEqual(["personal"]);
  }).pipe(Effect.provideService(McpInvocationContext, invocation)),
);

it.effect(
  "remember derives project scope from the authenticated thread and pins explicit memories",
  () =>
    Effect.gen(function* () {
      const { state, handlers } = fixture();
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
    }).pipe(Effect.provideService(McpInvocationContext, invocation)),
);

it.effect("capabilities and dynamic policies gate every operation, including writes", () =>
  Effect.gen(function* () {
    const { state, handlers } = fixture();
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
      handlers.memory_search({ query: "receipts" }).pipe(Effect.asVoid),
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
  }).pipe(Effect.provideService(McpInvocationContext, invocation)),
);
