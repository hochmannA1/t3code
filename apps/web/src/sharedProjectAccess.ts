import type { AuthSessionState } from "@t3tools/contracts";

export const isSharedProjectEnvironment = (environmentId: string | null | undefined): boolean =>
  environmentId?.startsWith("kara-share:") === true;

export function resolveSharedProjectAccess(
  environmentId: string | null | undefined,
  session: Pick<AuthSessionState, "authenticated" | "scopes"> | null,
) {
  const isSharedProject = isSharedProjectEnvironment(environmentId);
  const canOperate =
    !isSharedProject ||
    (session?.authenticated === true && session.scopes?.includes("orchestration:operate") === true);
  return {
    isSharedProject,
    canOperate,
    sendDisabledReason: canOperate
      ? null
      : session === null
        ? "Checking shared-project permissions…"
        : "This shared project is read only.",
  };
}
