import { expect, it } from "@effect/vitest";
import {
  decodeShell,
  protocolVersion,
  scopedShell,
  scopedShellItem,
  scopedHistoryPage,
  scopedThreadItem,
} from "./KaraSharedContractsV2.ts";

const project = {
  id: "project-shared",
  title: "Shared workspace",
  workspaceRoot: "/workspace/shared",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const shell = {
  schemaVersion: 1,
  snapshotSequence: 2,
  projects: [project, { ...project, id: "project-private", workspaceRoot: "/workspace/private" }],
  threads: [],
  archivedThreads: [],
};

it("decodes and scopes protocol-2 active shell snapshots to one project", () => {
  expect(protocolVersion).toBe(2);
  const decoded = decodeShell(shell);
  const scoped = scopedShell(decoded, "project-shared");
  expect(scoped.projects.map((entry: { id: string }) => entry.id)).toEqual(["project-shared"]);
  expect(scoped.threads).toEqual([]);
  expect(scoped.archivedThreads).toEqual([]);
  expect(() => scopedShell(decoded, "missing-project")).toThrow("Shared project is unavailable");
});

it("does not turn partial enrichment snapshots into authoritative thread membership", () => {
  const knownThreads = new Set(["thread-existing"]);
  const item = scopedShellItem(
    {
      kind: "snapshot",
      snapshot: { ...shell, projects: [project], threads: [], archivedThreads: [] },
      resolvedRepositoryIdentityRoots: ["/workspace/shared"],
    },
    "project-shared",
    knownThreads,
  );
  expect(item?.kind).toBe("snapshot");
  expect(item?.snapshot.projects.map((entry: { id: string }) => entry.id)).toEqual([
    "project-shared",
  ]);
  expect(item?.snapshot.threads).toEqual([]);
  expect(knownThreads).toEqual(new Set(["thread-existing"]));
  expect(
    scopedShellItem(
      {
        kind: "snapshot",
        snapshot: {
          ...shell,
          projects: [{ ...project, id: "project-private" }],
          threads: [],
          archivedThreads: [],
        },
        resolvedRepositoryIdentityRoots: ["/workspace/private"],
      },
      "project-shared",
      knownThreads,
    ),
  ).toBeNull();
});

it("keeps archive removals out of the active shell stream", () => {
  const knownThreads = new Set(["thread-shared"]);
  const archived = {
    kind: "thread.removed",
    sequence: 3,
    location: "archive",
    threadId: "thread-shared",
  };
  const active = { ...archived, location: "active" };
  expect(scopedShellItem(archived, "project-shared", knownThreads)).toBeNull();
  expect(scopedShellItem(active, "project-shared", knownThreads)).toEqual(active);
});

it("drops unknown history items while strictly decoding their page", () => {
  const item = { type: "future-turn-item", payload: { value: "future" }, extra: true };
  expect(
    scopedHistoryPage({
      snapshotSequence: 5,
      items: [
        {
          position: 1,
          visibility: "local",
          sourceThreadId: "thread-shared",
          sourceItemId: "item-1",
          item,
        },
      ],
      nextCursor: null,
      hasMoreHistory: false,
    }),
  ).toEqual({
    snapshotSequence: 5,
    items: [],
    nextCursor: null,
    hasMoreHistory: false,
  });
  expect(() =>
    scopedHistoryPage({ snapshotSequence: -1, items: [], nextCursor: null, hasMoreHistory: false }),
  ).toThrow();
});

it("drops unknown V2 events and rejects malformed known events", () => {
  const value = {
    kind: "event",
    sequence: 3,
    event: { type: "future.event", payload: { threadId: "thread-shared" }, ignored: true },
  };
  expect(scopedThreadItem(value, "project-shared", "thread-shared")).toBeNull();
  expect(
    scopedThreadItem(
      { ...value, event: { ...value.event, payload: { threadId: "thread-private" } } },
      "project-shared",
      "thread-shared",
    ),
  ).toBeNull();
  expect(() =>
    scopedThreadItem(
      {
        kind: "event",
        sequence: 4,
        event: { type: "run.created", payload: {} },
      },
      "project-shared",
      "thread-shared",
    ),
  ).toThrow();
  expect(() => decodeShell({ ...shell, schemaVersion: -1 })).toThrow();
});
