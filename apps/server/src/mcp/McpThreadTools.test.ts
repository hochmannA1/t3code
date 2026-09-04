import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ThreadToolkitRegistrationLive } from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("thread-tools-environment"),
  threadId: ThreadId.make("thread-a"),
  providerSessionId: "thread-tools-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["threads"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const TestLayer = ThreadToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const suffix of ["a", "b"]) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        ${`project-${suffix}`}, ${`Project ${suffix}`}, ${`/tmp/project-${suffix}`},
        '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, created_at, updated_at
      ) VALUES (
        ${`thread-${suffix}`}, ${`project-${suffix}`}, ${`Thread ${suffix}`},
        '{"instanceId":"codex","model":"gpt-5.6"}',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES (
        ${`message-${suffix}`}, ${`thread-${suffix}`}, 'user', ${`Remember project ${suffix}`},
        0, '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:01.000Z'
      )
    `;
  }
});

const call = (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = invocation,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("registers read-only thread tools and scopes each MCP request to its caller", () =>
  Effect.gen(function* () {
    yield* seed;
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual([
      "thread_list",
      "thread_read",
      "thread_search",
    ]);
    for (const { tool } of server.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.outputSchema?.type).toBe("object");
    }

    const first = yield* call("thread_list", {});
    expect(first.isError).toBe(false);
    expect(first.structuredContent).toMatchObject({
      currentThreadId: "thread-a",
      currentProjectId: "project-a",
      threads: [{ threadId: "thread-a" }],
      nextOffset: null,
    });

    const second = yield* call(
      "thread_list",
      {},
      {
        ...invocation,
        threadId: ThreadId.make("thread-b"),
        providerSessionId: "other-session",
      },
    );
    expect(second.isError).toBe(false);
    expect(second.structuredContent).toMatchObject({
      currentThreadId: "thread-b",
      currentProjectId: "project-b",
      threads: [{ threadId: "thread-b" }],
    });

    const search = yield* call("thread_search", { query: "Remember" });
    expect(search.isError).toBe(false);
    expect(search.structuredContent).toMatchObject({
      matches: [{ threadId: "thread-a", source: "user", snippet: "Remember project a" }],
    });

    const read = yield* call("thread_read", { threadId: "thread-a" });
    expect(read.isError).toBe(false);
    expect(read.structuredContent).toMatchObject({
      messages: [{ messageId: "message-a", role: "user", text: "Remember project a" }],
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("returns capability denials through MCP without conversation content", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const [name, args] of [
      ["thread_list", {}],
      ["thread_search", { query: "Remember" }],
      ["thread_read", { threadId: "thread-a" }],
    ] as const) {
      const denied = yield* call(name, args, { ...invocation, capabilities: new Set() });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        { type: "text", text: "Thread history access is unavailable for this agent session." },
      ]);
      expect(denied.structuredContent).toBeUndefined();
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects invalid paging, scopes, sorting, and empty searches at the MCP boundary", () =>
  Effect.gen(function* () {
    for (const [name, args] of [
      ["thread_list", { limit: 101 }],
      ["thread_list", { limit: 0 }],
      ["thread_list", { offset: -1 }],
      ["thread_list", { scope: "all-machines" }],
      ["thread_list", { sortBy: "unsupported" }],
      ["thread_search", { query: "" }],
      ["thread_read", {}],
    ] as const) {
      const invalid = yield* call(name, args).pipe(Effect.flip);
      expect(invalid._tag).toBe("InvalidParams");
    }
  }).pipe(Effect.provide(TestLayer)),
);
