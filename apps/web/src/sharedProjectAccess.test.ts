import type { AuthSessionState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSharedProjectAccess } from "./sharedProjectAccess";

const ownerSessionCases: Array<{
  readonly environmentId: string | null;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
}> = [
  { environmentId: "environment-owner", session: null },
  {
    environmentId: "environment-owner",
    session: { authenticated: true, scopes: ["orchestration:read"] },
  },
  { environmentId: null, session: null },
  {
    environmentId: null,
    session: { authenticated: true, scopes: ["orchestration:read"] },
  },
];

describe("resolveSharedProjectAccess", () => {
  it.each(ownerSessionCases)(
    "allows operation outside a shared-project environment",
    ({ environmentId, session }) => {
      expect(resolveSharedProjectAccess(environmentId, session)).toEqual({
        isSharedProject: false,
        canOperate: true,
        sendDisabledReason: null,
      });
    },
  );

  it("denies operation while the shared-project session is unresolved", () => {
    expect(resolveSharedProjectAccess("kara-share:share-1", null)).toEqual({
      isSharedProject: true,
      canOperate: false,
      sendDisabledReason: "Checking shared-project permissions…",
    });
  });

  it("denies a shared read session with the read-only message", () => {
    expect(
      resolveSharedProjectAccess("kara-share:share-1", {
        authenticated: true,
        scopes: ["orchestration:read"],
      }),
    ).toEqual({
      isSharedProject: true,
      canOperate: false,
      sendDisabledReason: "This shared project is read only.",
    });
  });

  it("denies an unauthenticated shared session even when it reports operate scope", () => {
    expect(
      resolveSharedProjectAccess("kara-share:share-1", {
        authenticated: false,
        scopes: ["orchestration:operate"],
      }),
    ).toEqual({
      isSharedProject: true,
      canOperate: false,
      sendDisabledReason: "This shared project is read only.",
    });
  });

  it("allows an authenticated shared session with operate scope", () => {
    expect(
      resolveSharedProjectAccess("kara-share:share-1", {
        authenticated: true,
        scopes: ["orchestration:operate"],
      }),
    ).toEqual({
      isSharedProject: true,
      canOperate: true,
      sendDisabledReason: null,
    });
  });

  it("does not treat a shared-project substring without the prefix as shared", () => {
    expect(resolveSharedProjectAccess("environment-kara-share:share-1", null)).toEqual({
      isSharedProject: false,
      canOperate: true,
      sendDisabledReason: null,
    });
  });
});
