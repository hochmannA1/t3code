import type { DraftId } from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isStandaloneProject } from "@t3tools/client-runtime/state/projects";
import { ChevronDownIcon, FolderIcon } from "lucide-react";
import { useMemo } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { ProjectPickerMenu } from "./ProjectPickerMenu";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const handleNewThread = useNewThreadHandler();

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjects.some(
            (project) =>
              !isStandaloneProject(project) &&
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) ===
                scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? null;
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const options = projectPickerEntries.map(({ group, targetProject }) => ({
    ref: scopeProjectRef(targetProject.environmentId, targetProject.id),
    value: group.projectKey,
    label: group.displayName,
    icon: <ProjectFavicon project={group} className="size-4 shrink-0" />,
    badge: showProjectEnvironments ? (
      <ProjectEnvironmentBadge
        group={group}
        primaryEnvironmentId={primaryEnvironmentId}
        machineByEnvironmentId={environmentMachineById}
      />
    ) : null,
  }));
  const selectProject = (projectRef: ScopedProjectRef | null) => {
    if (
      (projectRef === null && activeProjectRef === null) ||
      (projectRef !== null &&
        activeProjectRef !== null &&
        scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef))
    ) {
      return;
    }
    if (!draftId) return;
    void handleNewThread(projectRef, {
      replace: true,
      carryComposerContent: true,
    });
  };
  const projectLabel = activeProjectDisplayName ?? "No project";
  const projectSelector = (
    <ProjectPickerMenu
      activeValue={activeProjectKey}
      options={options}
      onSelect={selectProject}
      trigger={
        <button
          type="button"
          aria-label={`Project: ${projectLabel}`}
          className="pointer-events-auto inline-flex max-w-72 items-center gap-1.5 border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FolderIcon className="size-[0.8em] shrink-0" />
          <span className="truncate">{projectLabel}</span>
          <ChevronDownIcon className="size-[0.65em] shrink-0 text-muted-foreground" />
        </button>
      }
    />
  );

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  const headingLabel =
    activeProjectRef !== null && activeProjectDisplayName !== null
      ? `What should we work on in ${activeProjectDisplayName}?`
      : "What should we work on?";

  return (
    <h1
      aria-label={headingLabel}
      className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
    >
      {activeProjectRef !== null && activeProjectDisplayName !== null ? (
        <>What should we work on in {projectSelector}?</>
      ) : (
        <>What should we work on?</>
      )}
    </h1>
  );
}
