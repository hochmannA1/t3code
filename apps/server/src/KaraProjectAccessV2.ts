// @effect-diagnostics unsafeEffectTypeAssertion:off - RPC method tags select handler effect channels at runtime.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as C from "@t3tools/contracts";
import { projectConfig } from "./KaraSharedConfig.ts";
import type { ProjectGrant } from "./KaraProjectGrant.ts";
import { rpcAuthorizationError } from "./auth/RpcAuthorization.ts";
import { guardedDiffRoot, guardedFileInput, guardedProjectRoot } from "./KaraSharedFilesystem.ts";

const O = C.ORCHESTRATION_V2_WS_METHODS;
const W = C.WS_METHODS;
const readTags = new Set<string>([
  W.serverProbe,
  W.serverGetConfig,
  W.subscribeServerConfig,
  W.serverReportClientActivity,
  W.projectsListEntries,
  W.projectsReadFile,
  O.getArchivedShellSnapshot,
  O.getThreadProjection,
  O.getTurnItem,
  O.getTurnDiff,
  O.getFullThreadDiff,
  O.subscribeArchivedShell,
  O.subscribeShell,
  O.subscribeThread,
]);
const editTags = new Set<string>([O.dispatchCommand, O.launchThread, W.projectsWriteFile]);
const acceptedCommands = new Set([
  "thread.create",
  "message.dispatch",
  "run.interrupt",
  "runtime-request.respond",
  "thread.user-input.dismiss",
]);
const threadReadTags = new Set<string>([
  O.getThreadProjection,
  O.getTurnItem,
  O.getTurnDiff,
  O.getFullThreadDiff,
]);
const streamTags = new Set<string>(
  [...C.WsRpcGroup.requests.values()]
    .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
    .map((rpc) => rpc._tag),
);

type Handler = (...args: never[]) => unknown;
type SharedShell = C.OrchestrationV2ShellSnapshot;

function deny(requiredScope: "orchestration:read" | "orchestration:operate") {
  return Effect.fail(rpcAuthorizationError(requiredScope));
}

function denyStream(requiredScope: "orchestration:read" | "orchestration:operate") {
  return Stream.fail(rpcAuthorizationError(requiredScope));
}

function guardProject(
  project: SharedShell["projects"][number],
  shell: SharedShell,
  requiredScope: "orchestration:read" | "orchestration:operate",
) {
  return Effect.tryPromise({
    try: () => guardedProjectRoot(project, shell.projects),
    catch: () => rpcAuthorizationError(requiredScope),
  });
}

function resultFromNullish<A>(value: A | null) {
  return value === null ? Result.failVoid : Result.succeed(value);
}

function decodeShell(value: unknown): SharedShell {
  return Schema.decodeUnknownSync(C.OrchestrationV2ShellSnapshot)(value) as SharedShell;
}

function projectContext(value: unknown, grant: ProjectGrant) {
  const shell = decodeShell(value);
  const projects = shell.projects.filter((project) => project.id === grant.projectId);
  if (projects.length !== 1) throw new Error("Shared project is unavailable");
  return { shell, project: projects[0]! };
}

function scopedShell(value: unknown, grant: ProjectGrant) {
  const shell = decodeShell(value);
  const { project } = projectContext(shell, grant);
  return {
    ...shell,
    projects: [project],
    threads: shell.threads.filter((thread) => thread.projectId === grant.projectId),
    archivedThreads: [],
  };
}

function scopedArchivedShell(value: unknown, grant: ProjectGrant) {
  const snapshot = Schema.decodeUnknownSync(C.OrchestrationV2ArchivedShellSnapshot)(value);
  const projects = snapshot.projects.filter((project) => project.id === grant.projectId);
  if (projects.length !== 1) throw new Error("Shared project is unavailable");
  return {
    ...snapshot,
    projects,
    threads: snapshot.threads.filter((thread) => thread.projectId === grant.projectId),
  };
}

function scopedProjection(value: unknown, grant: ProjectGrant, threadId: string) {
  const projection = Schema.decodeUnknownSync(C.OrchestrationV2ThreadProjection)(value);
  if (projection.thread.id !== threadId || projection.thread.projectId !== grant.projectId)
    throw new Error("Shared thread is unavailable");
  return projection;
}

export function isSafeSharedProjectRelativePath(relative: unknown): relative is string | undefined {
  return (
    relative === undefined ||
    relative === "" ||
    (typeof relative === "string" &&
      !relative.startsWith("/") &&
      !relative.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(relative) &&
      !relative.split("/").some((part) => part === ".." || part === "." || part === ".git"))
  );
}

function isSafeCallerThreadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u0020\u007f/\\]/u.test(value)
  );
}

export function isAllowedSharedProjectCommand(
  input: unknown,
  shell: SharedShell,
  grant: ProjectGrant,
): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const command = input as Record<string, unknown>;
  if (typeof command.type !== "string" || !acceptedCommands.has(command.type)) return false;
  if (command.type === "thread.create") {
    return (
      command.projectId === grant.projectId &&
      isSafeCallerThreadId(command.threadId) &&
      ![...shell.threads, ...shell.archivedThreads].some(
        (entry) => entry.id === command.threadId,
      ) &&
      typeof command.title === "string" &&
      command.title.length <= 256 &&
      command.branch === null &&
      command.worktreePath === null &&
      command.runtimeMode !== "full-access" &&
      command.importedNativeThread === undefined
    );
  }
  const thread = shell.threads.find(
    (entry) => entry.id === command.threadId && entry.projectId === grant.projectId,
  );
  if (
    !thread ||
    thread.archivedAt !== null ||
    thread.runtimeMode === "full-access" ||
    command.runtimeMode === "full-access"
  )
    return false;
  if (command.type === "message.dispatch") {
    return (
      Array.isArray(command.attachments) &&
      command.attachments.length === 0 &&
      command.context === undefined &&
      command.sourcePlanRef === undefined &&
      command.notification === undefined &&
      command.scheduledTaskId === undefined &&
      command.senderThreadId === undefined &&
      command.titleSeed === undefined &&
      command.restartContinuationOfRunId === undefined &&
      command.usageLimitContinuationOfRunId === undefined &&
      command.manualContinuationOfRunId === undefined &&
      command.usageLimitRecoveryRequestId === undefined &&
      command.delegatedCompletion === undefined &&
      (command.creationSource === undefined || command.creationSource === "web") &&
      typeof command.dispatchMode === "object" &&
      command.dispatchMode !== null &&
      "type" in command.dispatchMode &&
      typeof command.dispatchMode.type === "string" &&
      ["start_immediately", "queue_after_active", "steer_active", "restart_active"].includes(
        command.dispatchMode.type,
      )
    );
  }
  if (command.type !== "runtime-request.respond") return true;
  return (
    command.attachmentsByQuestionId === undefined &&
    (command.decision !== undefined) !== (command.answers !== undefined)
  );
}

function shellStreamItem(value: unknown, grant: ProjectGrant, knownThreads: Set<string>) {
  const item = Schema.decodeUnknownSync(C.OrchestrationV2ShellStreamItem)(value);
  if (item.kind === "snapshot") {
    const partial = item.resolvedRepositoryIdentityRoots !== undefined;
    const snapshot = Schema.decodeUnknownSync(C.OrchestrationV2ShellSnapshot)(item.snapshot);
    const project = snapshot.projects.find((entry) => entry.id === grant.projectId);
    if (!project) return null;
    const scoped = {
      ...snapshot,
      projects: [project],
      threads: snapshot.threads.filter((thread) => thread.projectId === grant.projectId),
      archivedThreads: [],
    };
    if (!partial) {
      knownThreads.clear();
      for (const thread of [...scoped.threads, ...scoped.archivedThreads])
        knownThreads.add(thread.id);
    }
    const roots = item.resolvedRepositoryIdentityRoots?.filter(
      (root) => root === project.workspaceRoot,
    );
    if (partial && roots?.length === 0) return null;
    return {
      kind: "snapshot" as const,
      snapshot: scoped,
      ...(partial ? { resolvedRepositoryIdentityRoots: roots } : {}),
    };
  }
  if (item.kind === "project.updated") return item.project.id === grant.projectId ? item : null;
  if (item.kind === "project.removed") return item.projectId === grant.projectId ? item : null;
  if (item.kind === "thread.updated") {
    if (item.location !== "active" || item.thread.projectId !== grant.projectId) return null;
    knownThreads.add(item.thread.id);
    return item;
  }
  if (item.kind === "thread.removed")
    return item.location === "active" && knownThreads.has(item.threadId) ? item : null;
  return item.kind === "synchronized" ? item : null;
}

function archivedShellStreamItem(value: unknown, grant: ProjectGrant, knownThreads: Set<string>) {
  const item = Schema.decodeUnknownSync(C.OrchestrationV2ArchivedShellStreamItem)(value);
  if (item.kind === "snapshot") {
    const snapshot = scopedArchivedShell(item.snapshot, grant);
    knownThreads.clear();
    for (const thread of snapshot.threads) knownThreads.add(thread.id);
    return { kind: "snapshot" as const, snapshot };
  }
  if (item.kind === "thread.updated") {
    if (item.thread.projectId !== grant.projectId) return null;
    knownThreads.add(item.thread.id);
    return item;
  }
  return knownThreads.has(item.threadId) ? item : null;
}

function threadStreamItem(value: unknown, grant: ProjectGrant, threadId: string) {
  const item = Schema.decodeUnknownSync(C.OrchestrationV2ThreadStreamItem)(value);
  if (item.kind === "snapshot") {
    scopedProjection(item.projection, grant, threadId);
    return item;
  }
  if (item.kind === "event" && item.event.threadId === threadId) return item;
  // The outer RPC layer owns encoding. Unknown payloads have no validated
  // membership contract and must never be forwarded, even in reduced form.
  if (item.kind === "unknown-event") return null;
  return item.kind === "synchronized" ? item : null;
}

export function scopeProjectHandlersV2<
  HandlersT extends object,
  ShellError extends Error,
  ShellContext extends object,
>(
  handlers: HandlersT,
  grant: ProjectGrant | undefined,
  getShell: () => Effect.Effect<unknown, ShellError, ShellContext>,
): HandlersT {
  if (!grant) return handlers;
  const asEffect = <A>(value: unknown) =>
    value as Effect.Effect<A, ShellError | ReturnType<typeof rpcAuthorizationError>, ShellContext>;
  const projectThreadShell = (
    shell: SharedShell,
    threadId: string,
  ): Effect.Effect<
    SharedShell["threads"][number] | null,
    ShellError | ReturnType<typeof rpcAuthorizationError>,
    ShellContext
  > => {
    const active = [...shell.threads, ...shell.archivedThreads].find(
      (thread) => thread.id === threadId && thread.projectId === grant.projectId,
    );
    if (active) return Effect.succeed(active);
    const archiveHandler = (handlers as unknown as Record<string, (input: {}) => unknown>)[
      O.getArchivedShellSnapshot
    ];
    if (!archiveHandler) return Effect.succeed(null);
    return Effect.map(
      asEffect<unknown>(archiveHandler({})),
      (value) =>
        scopedArchivedShell(value, grant).threads.find(
          (thread) => thread.id === threadId && thread.projectId === grant.projectId,
        ) ?? null,
    );
  };
  const restricted = Object.fromEntries(
    Object.entries(handlers).map(([tag, rawHandler]) => {
      const handler = rawHandler as Handler;
      const allowed = readTags.has(tag) || (grant.role === "edit" && editTags.has(tag));
      if (!allowed)
        return [
          tag,
          () =>
            streamTags.has(tag) ? denyStream("orchestration:read") : deny("orchestration:read"),
        ];

      if (
        tag === O.subscribeShell ||
        tag === O.subscribeArchivedShell ||
        tag === O.subscribeThread
      ) {
        return [
          tag,
          (input: unknown) => {
            if (
              tag === O.subscribeThread &&
              (!input ||
                typeof input !== "object" ||
                typeof (input as Record<string, unknown>).threadId !== "string")
            ) {
              return denyStream("orchestration:read");
            }
            return Stream.unwrap(
              Effect.flatMap(getShell(), (rawShell) => {
                const shell = decodeShell(rawShell);
                const { project } = projectContext(shell, grant);
                const threadId =
                  tag === O.subscribeThread ? (input as { threadId: string }).threadId : undefined;
                const membership = threadId
                  ? Effect.map(projectThreadShell(shell, threadId), (thread) => thread !== null)
                  : Effect.succeed(true);
                return Effect.flatMap(guardProject(project, shell, "orchestration:read"), () =>
                  Effect.flatMap(membership, (belongs) => {
                    if (!belongs) return Effect.fail(rpcAuthorizationError("orchestration:read"));
                    const stream = handler(input as never) as Stream.Stream<
                      unknown,
                      ShellError | ReturnType<typeof rpcAuthorizationError>,
                      ShellContext
                    >;
                    if (tag === O.subscribeShell) {
                      const known = new Set(
                        shell.threads
                          .filter((thread) => thread.projectId === grant.projectId)
                          .map((thread) => thread.id),
                      );
                      return Effect.succeed(
                        Stream.map(stream, (item) => shellStreamItem(item, grant, known)).pipe(
                          Stream.filterMap(resultFromNullish),
                        ) as Stream.Stream<
                          unknown,
                          ShellError | ReturnType<typeof rpcAuthorizationError>,
                          ShellContext
                        >,
                      );
                    }
                    if (tag === O.subscribeArchivedShell) {
                      const known = new Set(
                        shell.archivedThreads
                          .filter((thread) => thread.projectId === grant.projectId)
                          .map((thread) => thread.id),
                      );
                      return Effect.succeed(
                        Stream.map(stream, (item) =>
                          archivedShellStreamItem(item, grant, known),
                        ).pipe(Stream.filterMap(resultFromNullish)) as Stream.Stream<
                          unknown,
                          ShellError | ReturnType<typeof rpcAuthorizationError>,
                          ShellContext
                        >,
                      );
                    }
                    return Effect.succeed(
                      Stream.map(stream, (item) => threadStreamItem(item, grant, threadId!)).pipe(
                        Stream.filterMap(resultFromNullish),
                      ) as Stream.Stream<
                        unknown,
                        ShellError | ReturnType<typeof rpcAuthorizationError>,
                        ShellContext
                      >,
                    );
                  }),
                );
              }),
            );
          },
        ];
      }

      if (
        tag === W.projectsListEntries ||
        tag === W.projectsReadFile ||
        tag === W.projectsWriteFile
      ) {
        return [
          tag,
          (input: unknown) =>
            Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              if (tag === W.projectsWriteFile && grant.role !== "edit")
                return deny("orchestration:operate");
              const threads = shell.threads.filter((thread) => thread.projectId === project.id);
              return Effect.flatMap(
                Effect.tryPromise({
                  try: () =>
                    guardedFileInput(
                      input,
                      project,
                      threads,
                      shell.projects,
                      tag === W.projectsWriteFile,
                    ),
                  catch: () =>
                    rpcAuthorizationError(
                      tag === W.projectsWriteFile ? "orchestration:operate" : "orchestration:read",
                    ),
                }),
                (scopedInput) => asEffect<unknown>(handler(scopedInput as never)),
              );
            }),
        ];
      }

      if (tag === O.dispatchCommand) {
        return [
          tag,
          (input: unknown) => {
            if (grant.role !== "edit") return deny("orchestration:operate");
            return Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              if (!isAllowedSharedProjectCommand(input, shell, grant))
                return deny("orchestration:operate");
              const command = input as Record<string, unknown>;
              const dispatch = (safeCommand: Record<string, unknown>) =>
                Effect.flatMap(guardProject(project, shell, "orchestration:operate"), () =>
                  asEffect<unknown>(handler(safeCommand as never)),
                );
              if (command.type === "thread.create") {
                const selection =
                  project.defaultModelSelection ??
                  shell.threads.find((thread) => thread.projectId === grant.projectId)
                    ?.modelSelection;
                if (!selection || !isSafeCallerThreadId(command.threadId))
                  return deny("orchestration:operate");
                const archiveHandler = (
                  handlers as unknown as Record<string, (input: {}) => unknown>
                )[O.getArchivedShellSnapshot];
                if (!archiveHandler) return deny("orchestration:operate");
                return Effect.flatMap(asEffect<unknown>(archiveHandler({})), (value) => {
                  const archived = Schema.decodeUnknownSync(C.OrchestrationV2ArchivedShellSnapshot)(
                    value,
                  );
                  if (archived.threads.some((thread) => thread.id === command.threadId))
                    return deny("orchestration:operate");
                  return dispatch({
                    ...command,
                    createdBy: "user",
                    creationSource: "web",
                    modelSelection: selection,
                    runtimeMode: "auto",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                  });
                });
              }
              const thread = shell.threads.find(
                (entry) => entry.id === command.threadId && entry.projectId === grant.projectId,
              );
              const projectionHandler = (
                handlers as unknown as Record<string, (input: { threadId: string }) => unknown>
              )[O.getThreadProjection];
              if (!thread || !projectionHandler) return deny("orchestration:operate");
              return Effect.flatMap(
                asEffect<unknown>(projectionHandler({ threadId: thread.id })),
                (value) => {
                  const projection = scopedProjection(value, grant, thread.id);
                  if (
                    command.type === "run.interrupt" &&
                    !projection.runs.some(
                      (run) =>
                        run.id === command.runId &&
                        ["preparing", "queued", "starting", "running", "waiting"].includes(
                          run.status,
                        ),
                    )
                  )
                    return deny("orchestration:operate");
                  if (
                    (command.type === "runtime-request.respond" ||
                      command.type === "thread.user-input.dismiss") &&
                    !projection.runtimeRequests.some(
                      (request) =>
                        request.id === command.requestId &&
                        request.status === "pending" &&
                        (command.type !== "thread.user-input.dismiss" ||
                          request.kind === "user_input"),
                    )
                  )
                    return deny("orchestration:operate");
                  if (command.type === "message.dispatch") {
                    const mode = command.dispatchMode as { type: string; targetRunId?: string };
                    if (
                      (mode.type === "steer_active" || mode.type === "restart_active") &&
                      !projection.runs.some(
                        (run) =>
                          run.id === mode.targetRunId &&
                          ["preparing", "starting", "running", "waiting"].includes(run.status),
                      )
                    )
                      return deny("orchestration:operate");
                  }
                  const safeCommand = {
                    ...command,
                    ...(command.type === "message.dispatch"
                      ? {
                          modelSelection: projection.thread.modelSelection,
                          createdBy: "user",
                          creationSource: "web",
                        }
                      : {}),
                  };
                  return dispatch(safeCommand);
                },
              );
            });
          },
        ];
      }

      if (tag === O.launchThread) {
        return [
          tag,
          (input: unknown) => {
            if (
              grant.role !== "edit" ||
              !input ||
              typeof input !== "object" ||
              Array.isArray(input)
            )
              return deny("orchestration:operate");
            return Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              const launch = input as Record<string, unknown>;
              const workspaceStrategy =
                launch.workspaceStrategy && typeof launch.workspaceStrategy === "object"
                  ? (launch.workspaceStrategy as Record<string, unknown>)
                  : {};
              const initialMessage =
                launch.initialMessage && typeof launch.initialMessage === "object"
                  ? (launch.initialMessage as Record<string, unknown>)
                  : undefined;
              const initialAttachments = initialMessage?.attachments;
              const requestedThreadId = launch.threadId;
              const threadIdOccupied =
                typeof requestedThreadId === "string" &&
                [...shell.threads, ...shell.archivedThreads].some(
                  (thread) => thread.id === requestedThreadId,
                );
              if (
                launch.projectId !== grant.projectId ||
                (requestedThreadId !== undefined && !isSafeCallerThreadId(requestedThreadId)) ||
                threadIdOccupied ||
                launch.reuseExistingThread === true ||
                workspaceStrategy.type !== "root" ||
                workspaceStrategy.branch !== undefined ||
                (Array.isArray(initialAttachments) && initialAttachments.length > 0) ||
                initialMessage?.context !== undefined
              )
                return deny("orchestration:operate");
              const selection =
                project.defaultModelSelection ??
                shell.threads.find((thread) => thread.projectId === grant.projectId)
                  ?.modelSelection;
              if (!selection) return deny("orchestration:operate");
              const safeInput = {
                ...launch,
                creationSource: "web",
                reuseExistingThread: false,
                modelSelection: selection,
                runtimeMode: "auto",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                ...(initialMessage
                  ? { initialMessage: { ...initialMessage, attachments: [] } }
                  : {}),
              };
              const launchChecked = Effect.flatMap(
                guardProject(project, shell, "orchestration:operate"),
                () =>
                  Effect.map(asEffect<unknown>(handler(safeInput as never)), (result) => {
                    const output = Schema.decodeUnknownSync(C.OrchestrationV2ThreadLaunchResult)(
                      result,
                    );
                    scopedProjection(output.projection, grant, output.threadId);
                    return output;
                  }),
              );
              if (requestedThreadId === undefined) return launchChecked;
              const archiveHandler = (
                handlers as unknown as Record<string, (input: {}) => unknown>
              )[O.getArchivedShellSnapshot];
              if (!archiveHandler) return deny("orchestration:operate");
              return Effect.flatMap(asEffect<unknown>(archiveHandler({})), (value) => {
                const archived = Schema.decodeUnknownSync(C.OrchestrationV2ArchivedShellSnapshot)(
                  value,
                );
                return archived.threads.some((thread) => thread.id === requestedThreadId)
                  ? deny("orchestration:operate")
                  : launchChecked;
              });
            });
          },
        ];
      }

      if (tag === O.getArchivedShellSnapshot) {
        return [
          tag,
          (input: unknown) =>
            Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              return Effect.flatMap(guardProject(project, shell, "orchestration:read"), () =>
                Effect.map(asEffect<unknown>(handler(input as never)), (snapshot) =>
                  scopedArchivedShell(snapshot, grant),
                ),
              );
            }),
        ];
      }

      if (threadReadTags.has(tag)) {
        return [
          tag,
          (input: unknown) => {
            if (
              !input ||
              typeof input !== "object" ||
              typeof (input as Record<string, unknown>).threadId !== "string"
            )
              return deny("orchestration:read");
            const threadId = (input as { threadId: string }).threadId;
            return Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              const needsDiffRoot =
                tag === O.getFullThreadDiff
                  ? (input as { toTurnCount?: number }).toTurnCount !== 0
                  : tag === O.getTurnDiff &&
                    (input as { fromTurnCount?: number; toTurnCount?: number }).toTurnCount !== 0 &&
                    (input as { fromTurnCount?: number; toTurnCount?: number }).fromTurnCount !==
                      (input as { fromTurnCount?: number; toTurnCount?: number }).toTurnCount;
              return Effect.flatMap(projectThreadShell(shell, threadId), (thread) => {
                if (!thread) return deny("orchestration:read");
                const validateRoot = needsDiffRoot
                  ? Effect.tryPromise({
                      try: () => guardedDiffRoot(project, thread, shell.projects),
                      catch: () => rpcAuthorizationError("orchestration:read"),
                    })
                  : Effect.void;
                return Effect.flatMap(validateRoot, () =>
                  Effect.map(asEffect<unknown>(handler(input as never)), (value) =>
                    tag === O.getThreadProjection
                      ? scopedProjection(value, grant, threadId)
                      : value,
                  ),
                );
              });
            });
          },
        ];
      }

      if (tag === W.serverGetConfig) {
        return [
          tag,
          (input: unknown) =>
            Effect.flatMap(getShell(), (rawShell) => {
              const shell = decodeShell(rawShell);
              const { project } = projectContext(shell, grant);
              return Effect.flatMap(guardProject(project, shell, "orchestration:read"), () =>
                Effect.map(asEffect<C.ServerConfig>(handler(input as never)), (config) =>
                  projectConfig(config, project, grant.shareId),
                ),
              );
            }),
        ];
      }

      if (tag === W.subscribeServerConfig) {
        return [
          tag,
          (input: unknown) =>
            Stream.unwrap(
              Effect.flatMap(getShell(), (rawShell) => {
                const shell = decodeShell(rawShell);
                const { project } = projectContext(shell, grant);
                return Effect.map(guardProject(project, shell, "orchestration:read"), () => {
                  const stream = handler(input as never) as Stream.Stream<
                    C.ServerConfigStreamEvent,
                    ShellError,
                    ShellContext
                  >;
                  return Stream.map(stream, (event) =>
                    event.type === "snapshot"
                      ? { ...event, config: projectConfig(event.config, project, grant.shareId) }
                      : null,
                  ).pipe(Stream.filterMap(resultFromNullish));
                });
              }),
            ),
        ];
      }

      return [
        tag,
        (input: unknown, ...args: unknown[]) =>
          asEffect<unknown>(handler(input as never, ...(args as never[]))),
      ];
    }),
  );
  return restricted as HandlersT;
}
