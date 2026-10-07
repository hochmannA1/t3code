import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts";
import { projectConfig } from "./KaraSharedConfig.ts";

const wire = <A, I>(schema: Schema.Codec<A, I>, value: unknown): any => {
  const codec = Schema.toCodecJson(schema);
  return Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(value));
};
export const protocolVersion = 2;
export const decodeShell = (value: unknown) => wire(C.OrchestrationV2ShellSnapshot, value);
export const decodeThread = (value: unknown) => wire(C.OrchestrationV2ThreadDetailSnapshot, value);
export const decodeCommand = (value: unknown) => wire(C.OrchestrationV2Command, value);
export const decodeConfig = (value: unknown) => wire(C.ServerConfig, value);
export function scopedShell(value: unknown, projectId: string) {
  const snapshot = decodeShell(value);
  const projects = snapshot.projects.filter((project: any) => project.id === projectId);
  if (projects.length !== 1) throw new Error("Shared project is unavailable");
  return {
    ...snapshot,
    projects,
    threads: snapshot.threads.filter((thread: any) => thread.projectId === projectId),
    archivedThreads: [],
  };
}
export function scopedArchivedShell(value: unknown, projectId: string) {
  const snapshot = wire(C.OrchestrationV2ArchivedShellSnapshot, value);
  const projects = snapshot.projects.filter((project: any) => project.id === projectId);
  if (projects.length !== 1) throw new Error("Shared project is unavailable");
  return {
    ...snapshot,
    projects,
    threads: snapshot.threads.filter((thread: any) => thread.projectId === projectId),
  };
}
export function scopedProjection(value: unknown, projectId: string, threadId: string) {
  const projection = wire(C.OrchestrationV2ThreadProjection, value);
  if (projection.thread.id !== threadId || projection.thread.projectId !== projectId)
    throw new Error("Shared thread is unavailable");
  return projection;
}
export function scopedThread(value: unknown, projectId: string, threadId: string) {
  const snapshot = decodeThread(value);
  scopedProjection(snapshot.projection, projectId, threadId);
  return snapshot;
}
export function scopedThreadProjection(value: unknown, projectId: string, threadId: string) {
  return scopedProjection(value, projectId, threadId);
}
export function scopedBoundedThread(value: unknown, projectId: string, threadId: string) {
  const snapshot = wire(C.OrchestrationV2ThreadBoundedSnapshot, value);
  scopedProjection(snapshot.projection, projectId, threadId);
  return snapshot;
}
export function scopedHistoryPage(value: unknown) {
  return wire(C.OrchestrationV2ThreadHistoryPage, value);
}
export function scopedLaunchResult(value: unknown, projectId: string) {
  const result = wire(C.OrchestrationV2RpcSchemas.launchThread.output, value);
  scopedProjection(result.projection, projectId, result.threadId);
  return result;
}
export function scopedConfig(value: unknown, project: any, shareId: string) {
  const codec = Schema.toCodecJson(C.ServerConfig);
  const config = Schema.decodeUnknownSync(codec)(value);
  return Schema.encodeSync(codec)(projectConfig(config, project, shareId));
}
export function scopedConfigEvent(value: unknown, project: any, shareId: string) {
  const event = wire(C.ServerConfigStreamEvent, value);
  if (event.type !== "snapshot") return null;
  return { version: 1, type: "snapshot", config: scopedConfig(event.config, project, shareId) };
}
export function scopedShellItem(value: unknown, projectId: string, knownThreads: Set<string>) {
  const item = wire(C.OrchestrationV2ShellStreamItem, value);
  if (item.kind === "snapshot") {
    const partial = item.resolvedRepositoryIdentityRoots !== undefined;
    const decoded = wire(C.OrchestrationV2ShellSnapshot, item.snapshot);
    const project = decoded.projects.find((entry: any) => entry.id === projectId);
    if (!project) return null;
    const snapshot = {
      ...decoded,
      projects: [project],
      threads: decoded.threads.filter((thread: any) => thread.projectId === projectId),
      archivedThreads: [],
    };
    if (!partial) {
      knownThreads.clear();
      for (const thread of [...snapshot.threads, ...snapshot.archivedThreads])
        knownThreads.add(thread.id);
    }
    const roots = item.resolvedRepositoryIdentityRoots?.filter(
      (root: string) => root === project.workspaceRoot,
    );
    if (partial && roots?.length === 0) return null;
    return {
      kind: "snapshot",
      snapshot,
      ...(partial ? { resolvedRepositoryIdentityRoots: roots } : {}),
    };
  }
  if (item.kind === "project.updated") return item.project.id === projectId ? item : null;
  if (item.kind === "project.removed") return item.projectId === projectId ? item : null;
  if (item.kind === "thread.updated") {
    if (item.location !== "active" || item.thread.projectId !== projectId) return null;
    knownThreads.add(item.thread.id);
    return item;
  }
  if (item.kind === "thread.removed")
    return item.location === "active" && knownThreads.has(item.threadId) ? item : null;
  if (item.kind === "synchronized") return item;
  return null;
}
export function scopedArchivedShellItem(
  value: unknown,
  projectId: string,
  knownThreads: Set<string>,
) {
  const item = wire(C.OrchestrationV2ArchivedShellStreamItem, value);
  if (item.kind === "snapshot") {
    const snapshot = scopedArchivedShell(item.snapshot, projectId);
    knownThreads.clear();
    for (const thread of snapshot.threads) knownThreads.add(thread.id);
    return { kind: "snapshot", snapshot };
  }
  if (item.kind === "thread.updated") {
    if (item.thread.projectId !== projectId) return null;
    knownThreads.add(item.thread.id);
    return item;
  }
  if (item.kind === "thread.removed") return knownThreads.has(item.threadId) ? item : null;
  return null;
}
export function scopedThreadItem(value: unknown, projectId: string, threadId: string) {
  const codec = Schema.toCodecJson(C.OrchestrationV2ThreadStreamItem);
  const decoded = Schema.decodeUnknownSync(codec)(value);
  if (decoded.kind === "unknown-event") return null;
  if (decoded.kind === "snapshot") {
    if (
      decoded.projection.thread.id !== threadId ||
      decoded.projection.thread.projectId !== projectId
    )
      throw new Error("Shared thread is unavailable");
    return Schema.encodeSync(codec)(decoded);
  }
  if (decoded.kind === "event" && decoded.event.threadId === threadId)
    return Schema.encodeSync(codec)(decoded);
  return decoded.kind === "synchronized" ? Schema.encodeSync(codec)(decoded) : null;
}
export function payload(tag: string, value: unknown) {
  const O = C.ORCHESTRATION_V2_WS_METHODS;
  const W = C.WS_METHODS;
  switch (tag) {
    case O.dispatchCommand:
      return decodeCommand(value);
    case O.launchThread:
      return wire(C.OrchestrationV2RpcSchemas.launchThread.input, value);
    case O.getArchivedShellSnapshot:
      return wire(C.OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input, value);
    case O.getThreadProjection:
      return wire(C.OrchestrationV2RpcSchemas.getThreadProjection.input, value);
    case O.getTurnItem:
      return wire(C.OrchestrationV2RpcSchemas.getTurnItem.input, value);
    case O.subscribeArchivedShell:
      return wire(C.OrchestrationV2RpcSchemas.subscribeArchivedShell.input, value);
    case O.subscribeShell:
      return wire(C.OrchestrationV2RpcSchemas.subscribeShell.input, value);
    case O.subscribeThread:
      return wire(C.OrchestrationV2RpcSchemas.subscribeThread.input, value);
    case O.getTurnDiff:
      return wire(C.OrchestrationV2RpcSchemas.getTurnDiff.input, value);
    case O.getFullThreadDiff:
      return wire(C.OrchestrationV2RpcSchemas.getFullThreadDiff.input, value);
    case W.projectsListEntries:
      return wire(C.ProjectListEntriesInput, value);
    case W.projectsReadFile:
      return wire(C.ProjectReadFileInput, value);
    case W.projectsWriteFile:
      return wire(C.ProjectWriteFileInput, value);
    case W.serverReportClientActivity:
      return wire(C.ClientActivityReportInput, value);
    case W.serverProbe:
    case W.serverGetConfig:
      return wire(Schema.Struct({}), value);
    case W.subscribeServerConfig:
      return wire(
        Schema.Struct({
          environmentThemes: Schema.optional(Schema.Boolean),
          usageLimitSources: Schema.optional(Schema.Boolean),
          usageLimitsCommand: Schema.optional(Schema.Boolean),
        }),
        value,
      );
    default:
      throw new Error("RPC is not permitted in shared projects");
  }
}
export function success(tag: string, value: unknown) {
  const O = C.ORCHESTRATION_V2_WS_METHODS;
  const W = C.WS_METHODS;
  switch (tag) {
    case O.dispatchCommand:
      return wire(C.OrchestrationV2RpcSchemas.dispatchCommand.output, value);
    case O.launchThread:
      return wire(C.OrchestrationV2RpcSchemas.launchThread.output, value);
    case O.getArchivedShellSnapshot:
      return wire(C.OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output, value);
    case O.getThreadProjection:
      return wire(C.OrchestrationV2RpcSchemas.getThreadProjection.output, value);
    case O.getTurnItem:
      return wire(C.OrchestrationV2RpcSchemas.getTurnItem.output, value);
    case O.getTurnDiff:
      return wire(C.OrchestrationV2RpcSchemas.getTurnDiff.output, value);
    case O.getFullThreadDiff:
      return wire(C.OrchestrationV2RpcSchemas.getFullThreadDiff.output, value);
    case W.projectsListEntries:
      return wire(C.ProjectListEntriesResult, value);
    case W.projectsReadFile:
      return wire(C.ProjectReadFileResult, value);
    case W.projectsWriteFile:
      return wire(C.ProjectWriteFileResult, value);
    case W.serverProbe:
      return {};
    case W.serverReportClientActivity:
      return undefined;
    default:
      throw new Error("RPC response is not permitted in shared projects");
  }
}
export const methods = { ...C.WS_METHODS, ...C.ORCHESTRATION_V2_WS_METHODS };
