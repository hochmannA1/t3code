import { describe, expect, it, vi } from "vite-plus/test";
import {
  CookieConnectionRegistration,
  CookieConnectionTarget,
} from "@t3tools/client-runtime/connection";

import {
  pollSharedProjectRegistrations,
  shouldPollSharedProjects,
  SHARED_PROJECT_POLL_INTERVAL_MS,
} from "./sharedProjects.ts";

const SHARE_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://kara.example";
const BASE_PATH = "/agents/t3";

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: SHARE_ID,
    name: "Shared workspace",
    role: "read",
    version: "3",
    openUrl: "https://untrusted.example/elsewhere",
    ...overrides,
  };
}

function poll(
  input: Partial<Parameters<typeof pollSharedProjectRegistrations>[0]> & {
    readonly fetch: typeof globalThis.fetch;
  },
) {
  return pollSharedProjectRegistrations({
    basePath: BASE_PATH,
    desktopBridgePresent: false,
    origin: ORIGIN,
    previous: [],
    ...input,
  });
}

describe("shared project platform discovery", () => {
  it("does not poll outside the local browser workspace context", async () => {
    const fetch = (() => {
      throw new Error("Unexpected request");
    }) as typeof globalThis.fetch;
    for (const input of [
      { desktopBridgePresent: true, basePath: BASE_PATH },
      { desktopBridgePresent: false, basePath: undefined },
      {
        desktopBridgePresent: false,
        basePath: "/agents/shared-projects/11111111-1111-4111-8111-111111111111/t3",
      },
    ]) {
      expect(await poll({ ...input, fetch })).toEqual({ _tag: "Disabled", registrations: [] });
    }
  });

  it("constructs same-origin project URLs and ignores the response openUrl", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      credentials: RequestCredentials | undefined;
      cache: RequestCache | undefined;
    }> = [];
    const result = await poll({
      fetch: (async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          credentials: init?.credentials,
          cache: init?.cache,
        });
        return Response.json({ projects: [project()] });
      }) as typeof globalThis.fetch,
    });

    expect(calls).toEqual([
      {
        url: `${ORIGIN}/agents/api/shared-projects`,
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      },
    ]);
    expect(result._tag).toBe("Success");
    const registration = result.registrations[0];
    expect(registration).toBeInstanceOf(CookieConnectionRegistration);
    expect(registration?.target).toBeInstanceOf(CookieConnectionTarget);
    expect(registration?.target).toMatchObject({
      environmentId: `kara-share:${SHARE_ID}`,
      label: "Shared workspace",
      role: "read",
      shareId: SHARE_ID,
      version: "3",
      httpBaseUrl: `${ORIGIN}/agents/shared-projects/${SHARE_ID}/t3/`,
      wsBaseUrl: `wss://kara.example/agents/shared-projects/${SHARE_ID}/t3/`,
    });
  });

  it("omits owner shares and applies role and version changes to registrations", async () => {
    const first = await poll({
      fetch: (async () =>
        Response.json({
          projects: [
            project({ id: "22222222-2222-4222-8222-222222222222", role: "owner" }),
            project(),
          ],
        })) as typeof globalThis.fetch,
    });
    const changed = await poll({
      fetch: (async () =>
        Response.json({
          projects: [project({ role: "edit", version: "4" })],
        })) as typeof globalThis.fetch,
    });

    expect(first.registrations).toHaveLength(1);
    expect(first.registrations[0]?.target).toMatchObject({ role: "read", version: "3" });
    expect(changed.registrations[0]?.target).toMatchObject({ role: "edit", version: "4" });
  });

  it("retains the last successful registrations on HTTP or validation failures", async () => {
    const existing = await poll({
      fetch: (async () => Response.json({ projects: [project()] })) as typeof globalThis.fetch,
    });
    const previous = existing.registrations;
    const failed = await poll({
      previous,
      fetch: (async () =>
        Response.json({ projects: [project({ role: "admin" })] })) as typeof globalThis.fetch,
    });
    const unavailable = await poll({
      previous,
      fetch: (async () => new Response(null, { status: 503 })) as typeof globalThis.fetch,
    });
    const networkFailure = await poll({
      previous,
      fetch: (async () => {
        throw new Error("Network unavailable");
      }) as typeof globalThis.fetch,
    });

    expect(failed._tag).toBe("Failure");
    expect(failed.registrations).toBe(previous);
    expect(unavailable._tag).toBe("Failure");
    expect(unavailable.registrations).toBe(previous);
    expect(networkFailure._tag).toBe("Failure");
    expect(networkFailure.registrations).toBe(previous);
  });

  it("treats a successful empty list as authoritative removal", async () => {
    const previous = await poll({
      fetch: (async () => Response.json({ projects: [project()] })) as typeof globalThis.fetch,
    });
    const removed = await poll({
      previous: previous.registrations,
      fetch: (async () => Response.json({ projects: [] })) as typeof globalThis.fetch,
    });

    expect(removed).toEqual({ _tag: "Success", registrations: [] });
  });

  it.each([401, 403])("treats HTTP %s as successful removal", async (status) => {
    const previous = await poll({
      fetch: (async () => Response.json({ projects: [project()] })) as typeof globalThis.fetch,
    });
    const removed = await poll({
      previous: previous.registrations,
      fetch: (async () => new Response(null, { status })) as typeof globalThis.fetch,
    });

    expect(removed).toEqual({ _tag: "Success", registrations: [] });
  });

  it("bounds the discovery request to five seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const result = await poll({
        fetch: (async (_url, init) => {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return Response.json({ projects: [] });
        }) as typeof globalThis.fetch,
      });

      expect(result._tag).toBe("Success");
      expect(timeout).toHaveBeenCalledWith(5_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("throttles shared-project polling to fifteen seconds after the initial poll", () => {
    expect(shouldPollSharedProjects(null, 0)).toBe(true);
    expect(shouldPollSharedProjects(10_000, 10_000 + SHARED_PROJECT_POLL_INTERVAL_MS - 1)).toBe(
      false,
    );
    expect(shouldPollSharedProjects(10_000, 10_000 + SHARED_PROJECT_POLL_INTERVAL_MS)).toBe(true);
  });
});
