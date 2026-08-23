import { describe, expect, it } from "vite-plus/test";

import { moveWorkSidebarSection, normalizeWorkSidebarSectionOrder } from "./useWorkSidebarView";

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
