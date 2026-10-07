import * as Schema from "effect/Schema";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useLocalStorage } from "./useLocalStorage";

export const WORK_SIDEBAR_VIEW_STORAGE_KEY = "t3code:work-sidebar-view";
export const WORK_SIDEBAR_SECTION_ORDER_STORAGE_KEY = "t3code:work-sidebar-section-order";
export const WORK_PINNED_PROJECT_KEYS_STORAGE_KEY = "t3code:work-pinned-project-keys";
export const WORK_PROJECTS_EXPANDED_STORAGE_KEY = "t3code:work-projects-expanded";
export const WORK_RECENTS_EXPANDED_STORAGE_KEY = "t3code:work-recents-expanded";
export const WORK_COMPLETED_EXPANDED_STORAGE_PREFIX = "t3code:work-completed-expanded:";

export type WorkSidebarView = "projects" | "activity";
export type WorkSidebarSection = "projects" | "recents";
export type ThreadSidebarVariant = "work-activity" | "work-projects" | "code-legacy" | "code-v2";

export function resolveThreadSidebarVariant(input: {
  readonly appExperience: "code" | "work";
  readonly workSidebarView: WorkSidebarView;
  readonly legacySidebarEnabled: boolean;
}): ThreadSidebarVariant {
  if (input.appExperience === "work") {
    return input.workSidebarView === "activity" ? "work-activity" : "work-projects";
  }
  return input.legacySidebarEnabled ? "code-legacy" : "code-v2";
}

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

export function useWorkSidebarPresentation() {
  const [pinnedProjectKeys, setPinnedProjectKeys] = useLocalStorage(
    WORK_PINNED_PROJECT_KEYS_STORAGE_KEY,
    [...DEFAULT_WORK_PINNED_PROJECT_KEYS],
    WorkPinnedProjectKeysSchema,
  );
  const [storedSectionOrder, setStoredSectionOrder] = useLocalStorage(
    WORK_SIDEBAR_SECTION_ORDER_STORAGE_KEY,
    [...DEFAULT_WORK_SIDEBAR_SECTION_ORDER],
    WorkSidebarSectionOrderSchema,
  );
  const [projectsExpanded, setProjectsExpanded] = useLocalStorage(
    WORK_PROJECTS_EXPANDED_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [recentsExpanded, setRecentsExpanded] = useLocalStorage(
    WORK_RECENTS_EXPANDED_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const sectionOrder = useMemo(
    () => normalizeWorkSidebarSectionOrder(storedSectionOrder),
    [storedSectionOrder],
  );
  return {
    pinnedProjectKeys,
    setPinnedProjectKeys,
    sectionOrder,
    setStoredSectionOrder,
    projectsExpanded,
    setProjectsExpanded,
    recentsExpanded,
    setRecentsExpanded,
  };
}

export function useWorkCompletedExpandedByProject(projectKeys: readonly string[]) {
  const serializedKeys = JSON.stringify([...new Set(projectKeys)]);
  const keys = useMemo(() => JSON.parse(serializedKeys) as string[], [serializedKeys]);
  const serializedEmptySnapshot = useMemo(
    () => JSON.stringify(keys.map((projectKey) => [projectKey, null] as const)),
    [keys],
  );
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined") return () => undefined;
      const storageKeys = new Set(
        keys.map((projectKey) => `${WORK_COMPLETED_EXPANDED_STORAGE_PREFIX}${projectKey}`),
      );
      const handleStorage = (event: StorageEvent) => {
        if (event.key === null || storageKeys.has(event.key)) onStoreChange();
      };
      const handleLocalStorageChange = (event: Event) => {
        const key = (event as CustomEvent<{ readonly key?: unknown }>).detail?.key;
        if (typeof key === "string" && storageKeys.has(key)) onStoreChange();
      };
      window.addEventListener("storage", handleStorage);
      window.addEventListener("t3code:local_storage_change", handleLocalStorageChange);
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener("t3code:local_storage_change", handleLocalStorageChange);
      };
    },
    [keys],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined") return serializedEmptySnapshot;
    try {
      return JSON.stringify(
        keys.map((projectKey) => [
          projectKey,
          window.localStorage.getItem(`${WORK_COMPLETED_EXPANDED_STORAGE_PREFIX}${projectKey}`),
        ]),
      );
    } catch {
      return serializedEmptySnapshot;
    }
  }, [keys, serializedEmptySnapshot]);
  const serializedSnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => serializedEmptySnapshot,
  );
  return useMemo(() => {
    const expandedByProject = new Map<string, boolean>();
    try {
      const values: unknown = JSON.parse(serializedSnapshot);
      if (!Array.isArray(values)) return expandedByProject;
      for (const entry of values) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        if (typeof entry[1] !== "string") {
          expandedByProject.set(entry[0], false);
          continue;
        }
        try {
          expandedByProject.set(entry[0], JSON.parse(entry[1]) === true);
        } catch {
          expandedByProject.set(entry[0], false);
        }
      }
    } catch {
      return expandedByProject;
    }
    return expandedByProject;
  }, [serializedSnapshot]);
}
