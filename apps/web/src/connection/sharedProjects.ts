import { EnvironmentId } from "@t3tools/contracts";
import {
  CookieConnectionRegistration,
  CookieConnectionTarget,
} from "@t3tools/client-runtime/connection";

const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SHARED_PROJECT_POLL_INTERVAL_MS = 15_000;

export function shouldPollSharedProjects(lastPollAt: number | null, now: number): boolean {
  return lastPollAt === null || now - lastPollAt >= SHARED_PROJECT_POLL_INTERVAL_MS;
}

export type SharedProjectPollResult =
  | {
      readonly _tag: "Disabled";
      readonly registrations: ReadonlyArray<CookieConnectionRegistration>;
    }
  | {
      readonly _tag: "Success";
      readonly registrations: ReadonlyArray<CookieConnectionRegistration>;
    }
  | {
      readonly _tag: "Failure";
      readonly registrations: ReadonlyArray<CookieConnectionRegistration>;
      readonly error: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function hubBasePath(basePath: string | undefined, desktopBridgePresent: boolean): string | null {
  if (desktopBridgePresent || typeof basePath !== "string") return null;
  const normalized = basePath.replace(/\/+$/u, "");
  if (
    !/^\/[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$/iu.test(normalized) ||
    !normalized.toLowerCase().endsWith("/t3") ||
    normalized.toLowerCase().includes("/shared-projects/")
  ) {
    return null;
  }
  return normalized.slice(0, -3);
}

function sharedProjectRegistrations(
  payload: unknown,
  origin: string,
  basePath: string,
): ReadonlyArray<CookieConnectionRegistration> {
  if (!isRecord(payload) || !Array.isArray(payload.projects)) {
    throw new Error("Invalid shared projects response.");
  }
  const seen = new Set<string>();
  const registrations: CookieConnectionRegistration[] = [];
  for (const value of payload.projects) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      !SHARE_ID.test(value.id) ||
      !isText(value.name, 512) ||
      !isText(value.version, 128) ||
      (value.role !== "owner" && value.role !== "read" && value.role !== "edit")
    ) {
      throw new Error("Invalid shared project entry.");
    }
    const shareId = value.id.toLowerCase();
    if (seen.has(shareId)) throw new Error("Duplicate shared project entry.");
    seen.add(shareId);
    if (value.role === "owner") continue;

    const httpUrl = new URL(
      `${basePath}/shared-projects/${encodeURIComponent(shareId)}/t3/`,
      origin,
    );
    const wsUrl = new URL(httpUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    registrations.push(
      new CookieConnectionRegistration({
        target: new CookieConnectionTarget({
          environmentId: EnvironmentId.make(`kara-share:${shareId}`),
          label: value.name,
          shareId,
          role: value.role,
          version: value.version,
          httpBaseUrl: httpUrl.href,
          wsBaseUrl: wsUrl.href,
        }),
      }),
    );
  }
  return registrations;
}

export async function pollSharedProjectRegistrations(input: {
  readonly basePath: string | undefined;
  readonly desktopBridgePresent: boolean;
  readonly origin: string;
  readonly previous: ReadonlyArray<CookieConnectionRegistration>;
  readonly fetch: typeof globalThis.fetch;
}): Promise<SharedProjectPollResult> {
  const basePath = hubBasePath(input.basePath, input.desktopBridgePresent);
  if (basePath === null) return { _tag: "Disabled", registrations: [] };

  try {
    const origin = new URL(input.origin);
    if (
      origin.origin !== input.origin ||
      (origin.protocol !== "http:" && origin.protocol !== "https:")
    ) {
      throw new Error("Invalid browser origin.");
    }
    const endpoint = new URL(`${basePath}/api/shared-projects`, origin);
    const response = await input.fetch(endpoint.href, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { _tag: "Success", registrations: [] };
    }
    if (!response.ok) throw new Error(`Shared projects request returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    return {
      _tag: "Success",
      registrations: sharedProjectRegistrations(payload, origin.origin, basePath),
    };
  } catch (error) {
    return { _tag: "Failure", registrations: input.previous, error };
  }
}
