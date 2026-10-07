import type { EnvironmentId } from "@t3tools/contracts";

import { isSharedProjectEnvironment, resolveSharedProjectAccess } from "../sharedProjectAccess";
import { useEnvironmentSessionState } from "../state/session";

export function useSharedProjectAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentSessionState(
    isSharedProjectEnvironment(environmentId) ? environmentId : null,
  );
  return resolveSharedProjectAccess(environmentId, session.data);
}
