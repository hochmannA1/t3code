import { describe, expect, it } from "vite-plus/test";
import { isStandaloneProject } from "./projectContext.ts";

describe("standalone chat workspace classification", () => {
  it.each([
    "/home/user/t3work/projects/2026-09-05/prepare-report",
    "C:\\Users\\User\\Chats\\2026-09-05\\prepare-report",
  ])("recognizes allocated folders across environment platforms: %s", (workspaceRoot) => {
    expect(isStandaloneProject({ title: "prepare-report", workspaceRoot })).toBe(true);
  });

  it.each([
    { title: "prepare-report", workspaceRoot: "/workspace/prepare-report" },
    { title: "Business project", workspaceRoot: "/workspace/2026-09-05/prepare-report" },
    { title: "Prepare Report", workspaceRoot: "/workspace/2026-09-05/Prepare Report" },
  ])("keeps explicit project names and ordinary folders as projects: %j", (project) => {
    expect(isStandaloneProject(project)).toBe(false);
  });
});
