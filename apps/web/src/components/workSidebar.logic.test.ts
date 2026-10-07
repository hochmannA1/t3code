import { describe, expect, it } from "vite-plus/test";

import {
  shouldCreateNewThreadInCurrentProject,
  shouldCreateStandaloneWorkTask,
} from "./Sidebar.logic";
import {
  partitionWorkSidebarProjects,
  selectVisibleProjectThreads,
  selectWorkSidebarProjectRows,
} from "./workSidebar.logic";

describe("Work new-task click routing", () => {
  it.each([0, 1, 3])(
    "uses standalone Work creation on a plain click with %i projects",
    (projectCount) => {
      const standalone = shouldCreateStandaloneWorkTask(true, false);
      const currentProject =
        !standalone && shouldCreateNewThreadInCurrentProject(false, projectCount);
      expect(standalone).toBe(true);
      expect(currentProject).toBe(false);
    },
  );

  it("keeps Shift+click on the project-specific path for Work", () => {
    const standalone = shouldCreateStandaloneWorkTask(true, true);
    expect(standalone).toBe(false);
    expect(!standalone && shouldCreateNewThreadInCurrentProject(true, 3)).toBe(true);
  });

  it("preserves Code's current-project behavior", () => {
    const standalone = shouldCreateStandaloneWorkTask(false, false);
    expect(standalone).toBe(false);
    expect(!standalone && shouldCreateNewThreadInCurrentProject(false, 0)).toBe(true);
    expect(!standalone && shouldCreateNewThreadInCurrentProject(false, 1)).toBe(true);
    expect(!standalone && shouldCreateNewThreadInCurrentProject(false, 3)).toBe(false);
    expect(!standalone && shouldCreateNewThreadInCurrentProject(true, 3)).toBe(true);
  });
});

type Thread = {
  readonly environmentId: string;
  readonly id: string;
};

const threadKey = (thread: Thread) => `${thread.environmentId}:${thread.id}`;

describe("selectWorkSidebarProjectRows", () => {
  it("restores pinned projects in their saved order", () => {
    const { pinned } = partitionWorkSidebarProjects({
      projects: [{ projectKey: "repo:first" }, { projectKey: "repo:second" }],
      pinnedProjectKeys: ["repo:second", "repo:first"],
      recentsProjectKey: "work:recents",
    });
    expect(pinned.map((project) => project.projectKey)).toEqual(["repo:second", "repo:first"]);
  });

  it("keeps pinned project order and places pinned Recents tasks before the sections", () => {
    const rows = selectWorkSidebarProjectRows({
      pinnedProjects: [{ projectKey: "repo:second" }, { projectKey: "repo:first" }],
      pinnedRecentProject: { projectKey: "work:recents" },
      pinnedRecentTaskCount: 1,
      sectionOrder: ["projects", "recents"],
      projectsExpanded: true,
      recentsExpanded: true,
      projects: [{ projectKey: "repo:other" }],
      recentsProject: { projectKey: "work:recents" },
    });

    expect(rows).toEqual([
      { project: { projectKey: "repo:second" }, threadVisibility: "all" },
      { project: { projectKey: "repo:first" }, threadVisibility: "all" },
      { project: { projectKey: "work:recents" }, threadVisibility: "pinned" },
      { project: { projectKey: "repo:other" }, threadVisibility: "all" },
      { project: { projectKey: "work:recents" }, threadVisibility: "unpinned" },
    ]);
  });

  it("puts Recents before Projects and omits collapsed sections", () => {
    const rows = selectWorkSidebarProjectRows({
      pinnedProjects: [{ projectKey: "repo:pinned" }],
      pinnedRecentProject: { projectKey: "work:recents" },
      pinnedRecentTaskCount: 2,
      sectionOrder: ["recents", "projects"],
      projectsExpanded: false,
      recentsExpanded: true,
      projects: [{ projectKey: "repo:project" }],
      recentsProject: { projectKey: "work:recents" },
    });

    expect(rows).toEqual([
      { project: { projectKey: "repo:pinned" }, threadVisibility: "all" },
      { project: { projectKey: "work:recents" }, threadVisibility: "pinned" },
      { project: { projectKey: "work:recents" }, threadVisibility: "unpinned" },
    ]);
  });
});

describe("selectVisibleProjectThreads", () => {
  const active = [
    { environmentId: "env-a", id: "one" },
    { environmentId: "env-b", id: "one" },
    { environmentId: "env-a", id: "two" },
  ];
  const completed = [{ environmentId: "env-a", id: "done" }];
  const select = (
    input: Partial<{
      projectExpanded: boolean;
      activeThreadKey: string | null;
      threadListExpanded: boolean;
      previewCount: number;
      completedExpanded: boolean;
    }> = {},
  ) =>
    selectVisibleProjectThreads({
      active,
      completed,
      projectExpanded: true,
      activeThreadKey: null,
      threadListExpanded: false,
      previewCount: 2,
      completedExpanded: false,
      key: threadKey,
      ...input,
    });

  it("applies the active preview and hides Completed until expanded", () => {
    expect(select()).toEqual({ active: active.slice(0, 2), completed: [] });
  });

  it("shows the expanded active list and Completed group only when expanded", () => {
    expect(select({ threadListExpanded: true, completedExpanded: true })).toEqual({
      active,
      completed,
    });
  });

  it("keeps only the matching active route in a collapsed project, without duplicating Completed", () => {
    expect(select({ projectExpanded: false, activeThreadKey: threadKey(completed[0]!) })).toEqual({
      active: completed,
      completed: [],
    });
    expect(select({ projectExpanded: false, activeThreadKey: threadKey(active[1]!) })).toEqual({
      active: [active[1]],
      completed: [],
    });
  });

  it("uses environment-scoped keys when ids collide", () => {
    expect(
      select({
        projectExpanded: false,
        activeThreadKey: "env-b:one",
      }),
    ).toEqual({ active: [active[1]], completed: [] });
  });
});
