import { describe, expect, it } from "vite-plus/test";

import {
  moveWorkSidebarSection,
  normalizeWorkSidebarSectionOrder,
  resolveThreadSidebarVariant,
} from "./useWorkSidebarView";
import {
  partitionWorkProjectThreads,
  partitionWorkSidebarProjects,
} from "../components/workSidebar.logic";

describe("Work sidebar view selection", () => {
  it("uses V2 activity and legacy projects for Work while respecting Code's legacy preference", () => {
    expect(
      resolveThreadSidebarVariant({
        appExperience: "work",
        workSidebarView: "activity",
        legacySidebarEnabled: true,
      }),
    ).toBe("work-activity");
    expect(
      resolveThreadSidebarVariant({
        appExperience: "work",
        workSidebarView: "projects",
        legacySidebarEnabled: false,
      }),
    ).toBe("work-projects");
    expect(
      resolveThreadSidebarVariant({
        appExperience: "code",
        workSidebarView: "projects",
        legacySidebarEnabled: true,
      }),
    ).toBe("code-legacy");
    expect(
      resolveThreadSidebarVariant({
        appExperience: "code",
        workSidebarView: "activity",
        legacySidebarEnabled: false,
      }),
    ).toBe("code-v2");
  });
});

describe("Work sidebar section order", () => {
  it("keeps both sections when stored state is incomplete or duplicated", () => {
    expect(normalizeWorkSidebarSectionOrder(["recents"])).toEqual(["recents", "projects"]);
    expect(normalizeWorkSidebarSectionOrder(["projects", "projects", "recents"])).toEqual([
      "projects",
      "recents",
    ]);
  });

  it("moves Recents above Projects and back again", () => {
    const recentsFirst = moveWorkSidebarSection(["projects", "recents"], "recents", "projects");
    expect(recentsFirst).toEqual(["recents", "projects"]);
    expect(moveWorkSidebarSection(recentsFirst, "projects", "recents")).toEqual([
      "projects",
      "recents",
    ]);
  });
});

describe("Work sidebar project and task groups", () => {
  it("restores pinned logical projects in saved order and keeps Recents synthetic", () => {
    const projects = [
      { projectKey: "repo:beta" },
      { projectKey: "work:recents" },
      { projectKey: "repo:alpha" },
    ];
    expect(
      partitionWorkSidebarProjects({
        projects,
        pinnedProjectKeys: ["missing", "repo:alpha", "repo:alpha", "work:recents"],
        recentsProjectKey: "work:recents",
      }),
    ).toEqual({
      pinned: [{ projectKey: "repo:alpha" }],
      projects: [{ projectKey: "repo:beta" }],
      recents: { projectKey: "work:recents" },
    });
  });

  it("completes only unpinned, unarchived settled tasks on settlement-capable environments", () => {
    const threads = [
      {
        id: "completed",
        environmentId: "capable",
        archivedAt: null,
        pinnedAt: null,
        settledOverride: "settled",
      },
      {
        id: "legacy-unpinned",
        environmentId: "capable",
        archivedAt: null,
        settledOverride: "settled",
      },
      {
        id: "pinned",
        environmentId: "capable",
        archivedAt: null,
        pinnedAt: "now",
        settledOverride: "settled",
      },
      {
        id: "unsupported",
        environmentId: "unsupported",
        archivedAt: null,
        pinnedAt: null,
        settledOverride: "settled",
      },
      {
        id: "active",
        environmentId: "capable",
        archivedAt: null,
        pinnedAt: null,
        settledOverride: null,
      },
      {
        id: "archived",
        environmentId: "capable",
        archivedAt: "now",
        pinnedAt: null,
        settledOverride: "settled",
      },
    ];
    const groups = partitionWorkProjectThreads(threads, new Set(["capable"]));
    expect(groups.completed.map((thread) => thread.id)).toEqual(["completed", "legacy-unpinned"]);
    expect(groups.active.map((thread) => thread.id)).toEqual(["pinned", "unsupported", "active"]);
  });
});
