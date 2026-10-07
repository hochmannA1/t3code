import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { ThreadToolkitRegistrationLive } from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("thread-tools-environment"),
  requestNamespace: "thread-tools-session",
  thread: {
    threadId: ThreadId.make("thread-a"),
    providerSessionId: "thread-tools-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "thread-tools-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const encodeTextPayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

const TestLayer = ThreadToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const suffix of ["a", "b"]) {
    const projectId = `project-${suffix}`;
    const threadId = `thread-${suffix}`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        ${projectId}, ${`Project ${suffix}`}, ${`/tmp/project-${suffix}`},
        '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, ${projectId}, ${`Thread ${suffix}`}, 'codex', 'full-access', 'default',
        NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL, NULL, '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES (
        ${`message-${suffix}`}, ${threadId}, NULL, NULL, 'user', 0,
        '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:01.000Z',
        ${encodeTextPayload({ text: `Remember project ${suffix}` })}
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
        thread: {
          threadId: ThreadId.make("thread-b"),
          providerSessionId: "other-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        requestNamespace: "other-session",
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
      const denied = yield* call(name, args, {
        ...invocation,
        capabilities: new Set(),
      });
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
