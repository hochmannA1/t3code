// @effect-diagnostics nodeBuiltinImport:off - Opt-in loopback packaged-runtime acceptance.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as C from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { measureHttpGet } from "./NetworkTransferMeasurement.integration.ts";
import { signProjectGrant } from "../src/KaraProjectGrant.ts";
import * as HubContracts from "../src/KaraSharedContractsV2.ts";
import { encodeThreadHistoryCursor } from "../src/orchestration-v2/threadHistoryPaging.ts";

const endpoint = process.env.KARA_SHARED_ACCEPTANCE_URL;
const O = C.ORCHESTRATION_V2_WS_METHODS;
const W = C.WS_METHODS;
const makeClient = RpcClient.make(C.WsRpcGroup);
type Client = Effect.Success<typeof makeClient>;
let token: string;
let secret: string;
let baseUrl: string;
let sharedId: C.ProjectId;
let privateId: C.ProjectId;
let activeId: C.ThreadId;
let archivedId: C.ThreadId;
let privateThreadId: C.ThreadId;
let sharedRoot: string;
const commandId = () => C.CommandId.make(randomUUID());
const threadId = () => C.ThreadId.make(randomUUID());

function grant(role: "read" | "edit", expired = false) {
  const now = Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000);
  return signProjectGrant(
    {
      v: 1,
      shareId: "11111111-1111-4111-8111-111111111111",
      projectId: sharedId,
      subject: "acceptance-member",
      tenant: "acceptance-tenant",
      role,
      exp: expired ? now - 1 : now + 25,
    },
    secret,
    expired ? now - 10 : now,
  );
}

function connect(signedGrant?: string, bearer = token) {
  const url = new URL("/ws", baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("orchestrationProtocol", String(C.ORCHESTRATION_PROTOCOL_VERSION));
  const constructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (address, protocols) =>
      new NodeSocket.NodeWS.WebSocket(address, protocols as string | string[] | undefined, {
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(signedGrant ? { "x-kara-project-grant": signedGrant } : {}),
        },
      }) as unknown as globalThis.WebSocket,
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(url.toString(), { openTimeout: "5 seconds" }).pipe(
        Layer.provide(constructor),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithScope(protocol, scope);
    return yield* makeClient.pipe(Effect.provide(context));
  });
}

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/Scope").Scope>) =>
  Effect.runPromise(effect.pipe(Effect.timeout("20 seconds"), Effect.scoped));

function createThread(projectId: C.ProjectId, id: C.ThreadId, runtimeMode = "approval-required") {
  return Schema.decodeUnknownSync(C.OrchestrationV2Command)({
    type: "thread.create",
    commandId: commandId(),
    threadId: id,
    projectId,
    createdBy: "user",
    creationSource: "web",
    title: "Empty runtime acceptance fixture",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
}

function shell(client: Client) {
  return client[O.subscribeShell]({ requestCompletionMarker: true }).pipe(
    Stream.filter(
      (item) => item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.map((item) => {
      if (item.kind !== "snapshot") throw new Error("Expected shell snapshot");
      return item.snapshot;
    }),
  );
}

async function http(
  path: string,
  signedGrant?: string,
  bearer = token,
  extraHeaders: Record<string, string> = {},
) {
  const response = await Effect.runPromise(
    measureHttpGet({
      url: new URL(path, baseUrl).toString(),
      headers: {
        ...extraHeaders,
        [C.ORCHESTRATION_PROTOCOL_HEADER]: C.ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(signedGrant ? { "x-kara-project-grant": signedGrant } : {}),
      },
    }),
  );
  return {
    status: response.status,
    json: async (): Promise<unknown> =>
      JSON.parse(Buffer.from(response.decodedBody).toString("utf8")),
  };
}

function assertDenied(value: unknown) {
  expect(value).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
}

describe.skipIf(!endpoint)(
  "packaged KARA shared-project transport (opt-in, no provider turns)",
  () => {
    beforeAll(async () => {
      const url = new URL(endpoint!);
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error("Acceptance may only target an explicit loopback HTTP runtime");
      }
      baseUrl = url.origin;
      const tokenFile = process.env.KARA_SHARED_ACCEPTANCE_TOKEN_FILE;
      const secretFile = process.env.KARA_SHARED_ACCEPTANCE_SECRET_FILE;
      const fixtureRoot = process.env.KARA_SHARED_ACCEPTANCE_FIXTURE_ROOT;
      if (!tokenFile || !secretFile || !fixtureRoot)
        throw new Error("Explicit private credential files and fixture root are required");
      token = readFileSync(tokenFile, "utf8").trim();
      secret = readFileSync(secretFile, "utf8").trim();
      const root = mkdtempSync(join(fixtureRoot, "shared-transport-"));
      sharedRoot = join(root, "shared");
      const privateRoot = join(root, "private");
      mkdirSync(sharedRoot);
      mkdirSync(privateRoot);
      sharedId = C.ProjectId.make(randomUUID());
      privateId = C.ProjectId.make(randomUUID());
      activeId = threadId();
      archivedId = threadId();
      privateThreadId = threadId();
      await run(
        Effect.gen(function* () {
          const owner = yield* connect();
          for (const [id, title, workspaceRoot] of [
            [sharedId, "Shared runtime fixture", sharedRoot],
            [privateId, "Private runtime fixture", privateRoot],
          ] as const) {
            const mutation = yield* Schema.decodeUnknownEffect(C.ProjectMutation)({
              type: "project.create",
              commandId: commandId(),
              projectId: id,
              title,
              workspaceRoot,
            });
            yield* owner[W.projectsMutate](mutation);
          }
          for (const [project, thread] of [
            [sharedId, activeId],
            [sharedId, archivedId],
            [privateId, privateThreadId],
          ] as const) {
            yield* owner[O.dispatchCommand](createThread(project, thread));
          }
          yield* owner[O.dispatchCommand]({
            type: "thread.archive",
            commandId: commandId(),
            threadId: archivedId,
          });
        }),
      );
      const manifest = process.env.KARA_SHARED_ACCEPTANCE_MANIFEST;
      if (manifest)
        writeFileSync(
          manifest,
          JSON.stringify(
            { sharedId, privateId, activeId, archivedId, privateThreadId, sharedRoot, privateRoot },
            null,
            2,
          ),
        );
    }, 30_000);

    it("owner retains both projects and active/archive visibility", async () => {
      await run(
        Effect.gen(function* () {
          const owner = yield* connect();
          const snapshot = yield* shell(owner);
          expect(snapshot.projects.map((p) => p.id)).toEqual(
            expect.arrayContaining([sharedId, privateId]),
          );
          expect(snapshot.threads.map((t) => t.id)).toEqual(
            expect.arrayContaining([activeId, privateThreadId]),
          );
          expect((yield* owner[O.getArchivedShellSnapshot]({})).threads.map((t) => t.id)).toContain(
            archivedId,
          );
        }),
      );
      expect((await http("/api/orchestration/shell")).status).toBe(200);
    });

    for (const role of ["read", "edit"] as const) {
      it(`${role} receives only granted active/archive snapshots and thread streams`, async () => {
        await run(
          Effect.gen(function* () {
            const client = yield* connect(grant(role));
            const snapshot = yield* shell(client);
            expect(snapshot.projects.map((p) => p.id)).toEqual([sharedId]);
            expect(snapshot.threads.map((t) => t.id)).toEqual([activeId]);
            expect(snapshot.archivedThreads).toEqual([]);
            const archive = yield* client[O.getArchivedShellSnapshot]({});
            expect(archive.projects.map((p) => p.id)).toEqual([sharedId]);
            expect(archive.threads.map((t) => t.id)).toEqual([archivedId]);
            for (const id of [activeId, archivedId]) {
              const projection = yield* client[O.getThreadProjection]({ threadId: id });
              expect(projection.thread.projectId).toBe(sharedId);
            }
            const item = yield* client[O.subscribeThread]({ threadId: activeId }).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            expect(item.kind).toBe("snapshot");
            assertDenied(
              yield* client[O.getThreadProjection]({ threadId: privateThreadId }).pipe(Effect.flip),
            );
            assertDenied(
              yield* client[O.subscribeThread]({ threadId: privateThreadId }).pipe(
                Stream.runHead,
                Effect.flip,
              ),
            );
            assertDenied(yield* client[W.automationsList]({}).pipe(Effect.flip));
            assertDenied(yield* client[W.serverGetSettings]({}).pipe(Effect.flip));
            assertDenied(
              yield* client[W.subscribeServerLifecycle]({}).pipe(Stream.runHead, Effect.flip),
            );
          }),
        );
      });

      it(`${role} HTTP filters shell and denies private state while serving scoped projections`, async () => {
        const shellResponse = await http("/api/orchestration/shell", grant(role));
        expect(shellResponse.status).toBe(200);
        const snapshot = Schema.decodeUnknownSync(
          Schema.toCodecJson(C.OrchestrationV2ShellSnapshot),
        )(await shellResponse.json());
        expect(snapshot.projects.map((p) => p.id)).toEqual([sharedId]);
        expect(snapshot.threads.map((t) => t.id)).toEqual([activeId]);
        expect(snapshot.archivedThreads).toEqual([]);
        for (const suffix of ["", "/bounded"]) {
          const response = await http(
            `/api/orchestration/threads/${activeId}${suffix}`,
            grant(role),
          );
          expect(response.status).toBe(200);
          const snapshot = Schema.decodeUnknownSync(
            Schema.toCodecJson(C.OrchestrationV2ThreadDetailSnapshot),
          )(await response.json());
          expect(snapshot.projection.thread.id).toBe(activeId);
          expect(snapshot.projection.thread.projectId).toBe(sharedId);
          expect(
            (await http(`/api/orchestration/threads/${privateThreadId}${suffix}`, grant(role)))
              .status,
          ).toBe(404);
        }
        const cursor = encodeThreadHistoryCursor({
          snapshotSequence: snapshot.snapshotSequence,
          sourceThreadId: privateThreadId,
          sourceItemId: "missing-item",
          position: 0,
        });
        expect(
          (
            await http(
              `/api/orchestration/threads/${privateThreadId}/history?cursor=${encodeURIComponent(cursor)}`,
              grant(role),
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await http(
              `/api/orchestration/threads/${activeId}/history?cursor=${encodeURIComponent(cursor)}`,
              grant(role),
            )
          ).status,
        ).toBe(404);
        expect((await http("/api/projects", grant(role))).status).toBe(401);
      });
    }

    it("Hub adapter accepts populated HTTP wire snapshots with V2 date codecs", async () => {
      const response = await http("/api/orchestration/shell");
      expect(response.status).toBe(200);
      const scoped = HubContracts.scopedShell(await response.json(), sharedId);
      expect(scoped.projects.map((p: { id: string }) => p.id)).toEqual([sharedId]);
      expect(scoped.threads.map((t: { id: string }) => t.id)).toEqual([activeId]);
      const detail = await http(`/api/orchestration/threads/${activeId}/bounded`);
      expect(detail.status).toBe(200);
      const bounded = HubContracts.scopedBoundedThread(await detail.json(), sharedId, activeId);
      expect(bounded.projection.thread.id).toBe(activeId);
    });

    it("reader cannot create; editor rejects private, archived-collision, and full-access creates", async () => {
      await run(
        Effect.gen(function* () {
          const reader = yield* connect(grant("read"));
          assertDenied(
            yield* reader[O.dispatchCommand](createThread(sharedId, threadId())).pipe(Effect.flip),
          );
          const editor = yield* connect(grant("edit"));
          for (const command of [
            createThread(privateId, threadId()),
            createThread(sharedId, archivedId),
            createThread(sharedId, threadId(), "full-access"),
          ]) {
            assertDenied(yield* editor[O.dispatchCommand](command).pipe(Effect.flip));
          }
          const id = threadId();
          yield* editor[O.dispatchCommand](createThread(sharedId, id));
          expect((yield* editor[O.getThreadProjection]({ threadId: id })).thread.projectId).toBe(
            sharedId,
          );
        }),
      );
    });

    it("reader cannot write files; editor can write/read only inside the shared root", async () => {
      await run(
        Effect.gen(function* () {
          const reader = yield* connect(grant("read"));
          const editor = yield* connect(grant("edit"));
          const file = {
            cwd: sharedRoot,
            relativePath: "acceptance.txt",
            contents: "Local transport fixture.\n",
          };
          assertDenied(yield* reader[W.projectsWriteFile](file).pipe(Effect.flip));
          yield* editor[W.projectsWriteFile](file);
          expect(
            (yield* reader[W.projectsReadFile]({
              cwd: sharedRoot,
              relativePath: file.relativePath,
            })).contents,
          ).toBe(file.contents);
          assertDenied(
            yield* editor[W.projectsReadFile]({
              cwd: sharedRoot,
              relativePath: "../private/private.txt",
            }).pipe(Effect.flip),
          );
          assertDenied(
            yield* editor[W.projectsWriteFile]({
              ...file,
              relativePath: "../private/private.txt",
            }).pipe(Effect.flip),
          );
        }),
      );
    });

    it("unsigned project headers do not authenticate or reduce the owner scope", async () => {
      const headers = { "x-kara-project-id": sharedId, "x-kara-project-role": "edit" };
      expect((await http("/api/orchestration/shell", undefined, "", headers)).status).toBe(401);
      const response = await http("/api/orchestration/shell", undefined, token, headers);
      expect(response.status).toBe(200);
      const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(C.OrchestrationV2ShellSnapshot))(
        await response.json(),
      );
      expect(snapshot.projects.map((p) => p.id)).toEqual(
        expect.arrayContaining([sharedId, privateId]),
      );
    });

    it("invalid MAC, expired grant, and missing bearer fail real authentication", async () => {
      const valid = grant("read");
      const parts = valid.split(".");
      const mac = Buffer.from(parts[2]!, "base64url");
      mac[0] = mac[0]! ^ 1;
      const invalid = `${parts[0]}.${parts[1]}.${mac.toString("base64url")}`;
      for (const [signed, bearer] of [
        [invalid, token],
        [grant("read", true), token],
        [grant("read"), ""],
      ]) {
        expect((await http(`/api/orchestration/threads/${activeId}`, signed, bearer)).status).toBe(
          401,
        );
        await expect(
          run(
            Effect.gen(function* () {
              const client = yield* connect(signed, bearer);
              return yield* client[W.serverGetConfig]({});
            }),
          ),
        ).rejects.toBeDefined();
      }
    }, 70_000);
  },
);
