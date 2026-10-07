export function partitionWorkSidebarProjects<T extends { readonly projectKey: string }>(input: {
  readonly projects: readonly T[];
  readonly pinnedProjectKeys: readonly string[];
  readonly recentsProjectKey: string;
}): { readonly pinned: T[]; readonly projects: T[]; readonly recents: T | null } {
  const recents =
    input.projects.find((project) => project.projectKey === input.recentsProjectKey) ?? null;
  const namedProjects = input.projects.filter(
    (project) => project.projectKey !== input.recentsProjectKey,
  );
  const namedProjectByKey = new Map(namedProjects.map((project) => [project.projectKey, project]));
  const pinnedKeys = new Set<string>();
  const pinned = input.pinnedProjectKeys.flatMap((projectKey) => {
    if (pinnedKeys.has(projectKey)) return [];
    pinnedKeys.add(projectKey);
    const project = namedProjectByKey.get(projectKey);
    return project ? [project] : [];
  });
  return {
    pinned,
    projects: namedProjects.filter((project) => !pinnedKeys.has(project.projectKey)),
    recents,
  };
}

export function selectWorkSidebarProjectRows<T extends { readonly projectKey: string }>(input: {
  readonly pinnedProjects: readonly T[];
  readonly pinnedRecentProject: T | null;
  readonly pinnedRecentTaskCount: number;
  readonly sectionOrder: readonly ("projects" | "recents")[];
  readonly projectsExpanded: boolean;
  readonly recentsExpanded: boolean;
  readonly projects: readonly T[];
  readonly recentsProject: T | null;
}): Array<{ readonly project: T; readonly threadVisibility: "all" | "pinned" | "unpinned" }> {
  const rows: Array<{
    readonly project: T;
    readonly threadVisibility: "all" | "pinned" | "unpinned";
  }> = input.pinnedProjects.map((project) => ({ project, threadVisibility: "all" }));
  if (input.pinnedRecentProject && input.pinnedRecentTaskCount > 0) {
    rows.push({ project: input.pinnedRecentProject, threadVisibility: "pinned" });
  }
  for (const section of input.sectionOrder) {
    if (section === "projects" && input.projectsExpanded) {
      rows.push(
        ...input.projects.map((project) => ({ project, threadVisibility: "all" as const })),
      );
    }
    if (section === "recents" && input.recentsExpanded && input.recentsProject) {
      rows.push({ project: input.recentsProject, threadVisibility: "unpinned" });
    }
  }
  return rows;
}

export function selectVisibleProjectThreads<T>(input: {
  readonly active: readonly T[];
  readonly completed: readonly T[];
  readonly projectExpanded: boolean;
  readonly activeThreadKey: string | null;
  readonly threadListExpanded: boolean;
  readonly previewCount: number;
  readonly completedExpanded: boolean;
  readonly key: (thread: T) => string;
}): { readonly active: T[]; readonly completed: T[] } {
  if (!input.projectExpanded) {
    const activeRouteThread = [...input.active, ...input.completed].find(
      (thread) => input.key(thread) === input.activeThreadKey,
    );
    return { active: activeRouteThread ? [activeRouteThread] : [], completed: [] };
  }
  return {
    active: input.threadListExpanded
      ? [...input.active]
      : input.active.slice(0, input.previewCount),
    completed: input.completedExpanded ? [...input.completed] : [],
  };
}

export function partitionWorkProjectThreads<
  Thread extends {
    readonly environmentId: string;
    readonly archivedAt: string | null;
    readonly pinnedAt?: string | null;
    readonly settledOverride: string | null;
  },
>(
  threads: readonly Thread[],
  settlementCapableEnvironmentIds: ReadonlySet<string>,
): { readonly active: Thread[]; readonly completed: Thread[] } {
  const active: Thread[] = [];
  const completed: Thread[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (
      thread.pinnedAt == null &&
      thread.settledOverride === "settled" &&
      settlementCapableEnvironmentIds.has(thread.environmentId)
    ) {
      completed.push(thread);
    } else {
      active.push(thread);
    }
  }
  return { active, completed };
}
