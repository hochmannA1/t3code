import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";
import { resolveAssetUrl } from "./assetUrls";
import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { toastManager } from "~/components/ui/toast";

export function useWorkspaceDownload(environmentId: EnvironmentId | null, cwd: string | undefined) {
  const connection = usePreparedConnection(environmentId);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(
    async (path: string) => {
      try {
        if (!environmentId || !cwd || connection._tag !== "Some")
          throw new Error("Connect to the environment to download files.");
        const result = await createUrl({
          environmentId,
          input: { resource: { _tag: "workspace-download", cwd, path } },
        });
        if (result._tag !== "Success")
          throw new Error("The file could not be prepared for download.");
        const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
        if (!url) throw new Error("Invalid download URL.");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Download failed",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [environmentId, cwd, connection, createUrl],
  );
}
