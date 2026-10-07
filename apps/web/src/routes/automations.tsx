import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import {
  AutomationsPage,
  type AutomationsPageSearch,
} from "../components/automations/AutomationsPage";

export const Route = createFileRoute("/automations")({
  validateSearch: (raw: Record<string, unknown>): AutomationsPageSearch => ({
    ...(raw.create === true || raw.create === "true" ? { create: true } : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.threadId === "string" && raw.threadId
      ? { threadId: raw.threadId as ThreadId }
      : {}),
  }),
  component: AutomationsRoute,
});

function AutomationsRoute() {
  return <AutomationsPage search={Route.useSearch()} />;
}
