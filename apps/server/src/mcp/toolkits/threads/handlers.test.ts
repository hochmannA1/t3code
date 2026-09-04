import { expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { makeThreadToolkitHandlers } from "./handlers.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("current"),
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["threads"]),
  issuedAt: 1,
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["p1", "p2", "deleted-project"]) {
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
      VALUES (${id}, ${id}, ${`/tmp/${id}`}, '[]', '2026-09-01', '2026-09-01', ${id === "deleted-project" ? "2026-09-02" : null})
    `;
  }
  for (const [id, project, title, created, updated, archived, deleted] of [
    ["current", "p1", "Current task", "2026-09-01", "2026-09-01", null, null],
    ["alpha", "p1", "Alpha 100%_!", "2026-09-02", "2026-09-04", null, null],
    ["beta", "p1", "beta task", "2026-09-03", "2026-09-04", null, null],
    ["archived", "p1", "Archived task", "2026-09-01", "2026-09-01", "2026-09-02", null],
    ["other", "p2", "Other task", "2026-09-01", "2026-09-01", null, null],
    ["deleted", "p1", "Deleted task", "2026-09-01", "2026-09-01", null, "2026-09-02"],
    ["orphan", "deleted-project", "Orphan task", "2026-09-01", "2026-09-01", null, null],
  ] as const) {
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, archived_at, deleted_at)
      VALUES (${id}, ${project}, ${title}, '{}', ${created}, ${updated}, ${archived}, ${deleted})
    `;
  }
  const handlers = makeThreadToolkitHandlers(sql);
  return { sql, handlers };
});

const message = Effect.fn("test.message")(function* (
  id: string,
  threadId: string,
  role: string,
  text: string,
  options: { streaming?: boolean; final?: boolean; createdAt?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES (${id}, ${threadId}, ${role}, ${text}, ${options.streaming ? 1 : 0}, ${options.createdAt ?? "2026-09-01"}, '2026-09-01')
  `;
  if (options.final) {
    yield* sql`
      INSERT INTO projection_turns (thread_id, turn_id, assistant_message_id, state, requested_at, checkpoint_files_json)
      VALUES (${threadId}, ${`turn-${id}`}, ${id}, 'completed', '2026-09-01', '[]')
    `;
  }
});

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provide(SqlitePersistenceMemory),
  );

it.effect("lists deterministic pages, literal title filters, and all sort options", () =>
  provide(
    Effect.gen(function* () {
      const { handlers } = yield* seed;
      const first = yield* handlers.thread_list({ limit: 1 });
      expect(first.threads.map((thread) => thread.threadId)).toEqual(["alpha"]);
      expect(first.nextOffset).toBe(1);
      const second = yield* handlers.thread_list({ limit: 1, offset: first.nextOffset! });
      expect(second.threads.map((thread) => thread.threadId)).toEqual(["beta"]);
      const last = yield* handlers.thread_list({ limit: 1, offset: 2 });
      expect(last.nextOffset).toBeNull();
      expect(
        (yield* handlers.thread_list({ title: "%_!" })).threads.map((thread) => thread.threadId),
      ).toEqual(["alpha"]);
      expect(
        (yield* handlers.thread_list({ sortBy: "createdAt" })).threads.map(
          (thread) => thread.threadId,
        ),
      ).toEqual(["beta", "alpha", "current"]);
      expect(
        (yield* handlers.thread_list({ sortBy: "title", sortDirection: "asc" })).threads.map(
          (thread) => thread.threadId,
        ),
      ).toEqual(["alpha", "beta", "current"]);
      expect(
        (yield* handlers.thread_list({ sortBy: "updatedAt", sortDirection: "asc" })).threads[0]
          ?.threadId,
      ).toBe("current");
    }),
  ),
);

it.effect("requires explicit environment and archive scope and never reveals deleted data", () =>
  provide(
    Effect.gen(function* () {
      const { handlers } = yield* seed;
      expect((yield* handlers.thread_list({})).threads).toHaveLength(3);
      expect((yield* handlers.thread_list({ includeArchived: true })).threads).toHaveLength(4);
      const all = yield* handlers.thread_list({ scope: "environment", includeArchived: true });
      expect(all.threads.map((thread) => thread.threadId).sort()).toEqual([
        "alpha",
        "archived",
        "beta",
        "current",
        "other",
      ]);
      for (const id of ["other", "archived", "deleted", "orphan"]) {
        const error = yield* handlers
          .thread_read({ threadId: ThreadId.make(id) })
          .pipe(Effect.flip);
        expect(error.code).toBe("not-found");
      }
      expect(
        (yield* handlers.thread_read({ threadId: ThreadId.make("other"), scope: "environment" }))
          .thread.projectId,
      ).toBe("p2");
      expect(
        (yield* handlers.thread_read({
          threadId: ThreadId.make("archived"),
          includeArchived: true,
        })).thread.archivedAt,
      ).not.toBeNull();
      for (const id of ["deleted", "orphan"]) {
        expect(
          (yield* handlers
            .thread_read({
              threadId: ThreadId.make(id),
              scope: "environment",
              includeArchived: true,
            })
            .pipe(Effect.flip)).code,
        ).toBe("not-found");
      }
    }),
  ),
);

it.effect("checks capability and current thread/project availability on every call", () =>
  provide(
    Effect.gen(function* () {
      const { handlers, sql } = yield* seed;
      const denied = yield* handlers.thread_list({}).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set<McpInvocationContext.McpCapability>(),
        }),
        Effect.flip,
      );
      expect(denied.code).toBe("access-disabled");
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-09-04' WHERE thread_id = 'current'`;
      expect((yield* handlers.thread_list({ scope: "environment" }).pipe(Effect.flip)).code).toBe(
        "not-found",
      );
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'current'`;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-09-04' WHERE project_id = 'p1'`;
      expect(
        (yield* handlers.thread_search({ query: "task", scope: "environment" }).pipe(Effect.flip))
          .code,
      ).toBe("not-found");
    }),
  ),
);

it.effect(
  "searches titles and final conversation text with bounded snippets and literal wildcards",
  () =>
    provide(
      Effect.gen(function* () {
        const { handlers, sql } = yield* seed;
        yield* message(
          "alpha-user",
          "alpha",
          "user",
          `prefix ${"x".repeat(6000)} needle %_! ending`,
        );
        yield* message("beta-final", "beta", "assistant", "needle final answer", { final: true });
        yield* message("hidden-commentary", "current", "assistant", "needle commentary");
        yield* message("hidden-tool", "current", "tool", "needle tool result");
        yield* message("hidden-streaming", "current", "user", "needle streaming", {
          streaming: true,
        });
        yield* message("hidden-running", "current", "assistant", "needle running commentary", {
          final: true,
        });
        yield* sql`UPDATE projection_turns SET state = 'running' WHERE assistant_message_id = 'hidden-running'`;
        for (const id of ["other", "archived", "deleted", "orphan"]) {
          yield* message(`user-${id}`, id, "user", "needle scoped result");
        }
        const first = yield* handlers.thread_search({ query: "needle", limit: 1 });
        expect(first.matches[0]).toMatchObject({
          threadId: "alpha",
          source: "user",
          messageId: "alpha-user",
        });
        expect(first.matches[0]?.snippet).toContain("needle");
        expect(first.matches[0]!.snippet.length).toBeLessThanOrEqual(500);
        expect(first.nextOffset).toBe(1);
        const second = yield* handlers.thread_search({ query: "needle", limit: 1, offset: 1 });
        expect(second.matches[0]).toMatchObject({ threadId: "beta", source: "assistant" });
        expect(second.nextOffset).toBeNull();
        const literal = yield* handlers.thread_search({ query: "%_!" });
        expect(literal.matches).toHaveLength(1);
        expect(literal.matches[0]).toMatchObject({ source: "title", messageId: null });
        const all = yield* handlers.thread_search({
          query: "needle",
          scope: "environment",
          includeArchived: true,
        });
        expect(all.matches.map((match) => match.threadId).sort()).toEqual([
          "alpha",
          "archived",
          "beta",
          "other",
        ]);
      }),
    ),
);

it.effect("reads chronological message pages and continues clipped final replies", () =>
  provide(
    Effect.gen(function* () {
      const { handlers, sql } = yield* seed;
      yield* message("first", "alpha", "user", "Question", { createdAt: "2026-09-01" });
      yield* message("second", "alpha", "assistant", "x".repeat(4100) + " THE END", {
        final: true,
        createdAt: "2026-09-02",
      });
      yield* message("third", "alpha", "user", "Follow-up", { createdAt: "2026-09-03" });
      yield* message("commentary", "alpha", "assistant", "private commentary");
      yield* message("running", "alpha", "assistant", "running commentary", { final: true });
      yield* sql`UPDATE projection_turns SET state = 'running' WHERE assistant_message_id = 'running'`;
      yield* message("streaming", "alpha", "assistant", "unfinished answer", {
        final: true,
        streaming: true,
      });
      yield* message("foreign", "other", "user", "other project text");
      const first = yield* handlers.thread_read({ threadId: ThreadId.make("alpha"), limit: 2 });
      expect(first.messages.map((row) => row.messageId)).toEqual(["first", "second"]);
      expect(first.messages[1]).toMatchObject({
        text: "x".repeat(4000),
        truncated: true,
        nextTextOffset: 4000,
      });
      expect(first.nextOffset).toBe(2);
      const rest = yield* handlers.thread_read({
        threadId: ThreadId.make("alpha"),
        messageId: MessageId.make("second"),
        textOffset: 4000,
      });
      expect(rest.messages).toHaveLength(1);
      expect(rest.messages[0]).toMatchObject({
        text: "x".repeat(100) + " THE END",
        truncated: false,
        nextTextOffset: null,
      });
      const last = yield* handlers.thread_read({ threadId: ThreadId.make("alpha"), offset: 2 });
      expect(last.messages.map((row) => row.messageId)).toEqual(["third"]);
      expect(last.nextOffset).toBeNull();
      expect(
        (yield* handlers.thread_read({
          threadId: ThreadId.make("alpha"),
          messageId: MessageId.make("foreign"),
        })).messages,
      ).toEqual([]);
    }),
  ),
);
