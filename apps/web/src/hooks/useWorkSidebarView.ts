import * as Schema from "effect/Schema";

import { useLocalStorage } from "./useLocalStorage";

export const WORK_SIDEBAR_VIEW_STORAGE_KEY = "t3code:work-sidebar-view";
export const WORK_SIDEBAR_SECTION_ORDER_STORAGE_KEY = "t3code:work-sidebar-section-order";
export const WORK_PINNED_PROJECT_KEYS_STORAGE_KEY = "t3code:work-pinned-project-keys";

export type WorkSidebarView = "projects" | "activity";
export type WorkSidebarSection = "projects" | "recents";

const WorkSidebarViewSchema = Schema.Literals(["projects", "activity"]);
export const WorkSidebarSectionOrderSchema = Schema.Array(Schema.Literals(["projects", "recents"]));
export const WorkPinnedProjectKeysSchema = Schema.Array(Schema.String);

export const DEFAULT_WORK_SIDEBAR_SECTION_ORDER: readonly WorkSidebarSection[] = [
  "projects",
  "recents",
];
export const DEFAULT_WORK_PINNED_PROJECT_KEYS: readonly string[] = [];

export function normalizeWorkSidebarSectionOrder(
  order: readonly WorkSidebarSection[],
): WorkSidebarSection[] {
  const uniqueStoredSections = order.filter((section, index) => order.indexOf(section) === index);
  return uniqueStoredSections.concat(
    DEFAULT_WORK_SIDEBAR_SECTION_ORDER.filter((section) => !uniqueStoredSections.includes(section)),
  );
}

export function moveWorkSidebarSection(
  order: readonly WorkSidebarSection[],
  active: WorkSidebarSection,
  over: WorkSidebarSection,
): WorkSidebarSection[] {
  const normalized = normalizeWorkSidebarSectionOrder(order);
  const activeIndex = normalized.indexOf(active);
  const overIndex = normalized.indexOf(over);
  if (activeIndex === overIndex) return normalized;
  const next = [...normalized];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved!);
  return next;
}

export function useWorkSidebarView() {
  return useLocalStorage<WorkSidebarView, WorkSidebarView>(
    WORK_SIDEBAR_VIEW_STORAGE_KEY,
    "activity",
    WorkSidebarViewSchema,
  );
}
