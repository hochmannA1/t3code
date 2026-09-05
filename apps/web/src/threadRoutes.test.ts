import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });

  it("resolves the backing thread while a draft route is being promoted", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: scopeThreadRef("env-2" as never, ThreadId.make("server-thread")),
      }),
    ).toEqual({
      environmentId: "env-2",
      threadId: "server-thread",
    });
  });

  it("does not treat a draft's reserved thread ref as an active sidebar thread", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });

  it("keeps shell-only server threads in the loading state", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: true,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailError: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
  });

  it("renders server details and local drafts when they are ready", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: true,
        serverThreadDetailExists: true,
        serverThreadDetailDeleted: false,
        serverThreadDetailError: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailError: false,
        draftThreadExists: true,
      }),
    ).toBe("ready");
  });

  it("waits for archived deep links that are absent from the shell", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailError: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
  });

  it("surfaces detail failures without treating shell absence as deletion", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: false,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: false,
        serverThreadDetailError: true,
        draftThreadExists: false,
      }),
    ).toBe("error");
  });

  it("renders cached details and drafts before the shell arrives", () => {
    for (const draftThreadExists of [false, true]) {
      expect(
        resolveThreadRouteRenderState({
          serverThreadShellExists: false,
          serverThreadDetailExists: !draftThreadExists,
          serverThreadDetailDeleted: false,
          serverThreadDetailError: false,
          draftThreadExists,
        }),
      ).toBe("ready");
    }
  });

  it("does not resurrect cached details after an authoritative deletion", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: true,
        serverThreadDetailExists: true,
        serverThreadDetailDeleted: true,
        serverThreadDetailError: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("redirects deleted shell-only threads", () => {
    expect(
      resolveThreadRouteRenderState({
        serverThreadShellExists: true,
        serverThreadDetailExists: false,
        serverThreadDetailDeleted: true,
        serverThreadDetailError: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });
});
