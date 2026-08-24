import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { isStandaloneProject } from "@t3tools/client-runtime/state/projects";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "./providerInstances";

export const APP_EXPERIENCES = ["code", "work"] as const;
export type AppExperience = (typeof APP_EXPERIENCES)[number];
export const DEFAULT_APP_EXPERIENCE: AppExperience = "work";

export function isAppExperience(value: unknown): value is AppExperience {
  return value === "code" || value === "work";
}

export const isStandaloneWorkProject = isStandaloneProject;

export const WORK_COMPLEXITIES = ["simple", "normal", "hard"] as const;
export type WorkComplexity = (typeof WORK_COMPLEXITIES)[number];
export const DEFAULT_WORK_COMPLEXITY: WorkComplexity = "normal";
export const WORK_CODEX_DRIVER = ProviderDriverKind.make("codex");
export const DEFAULT_WORK_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(WORK_CODEX_DRIVER);

export function workProjectDirectoryName(title: string): string {
  let pathSafeTitle = "";
  let replacingPathSeparator = false;
  for (const character of title.trim()) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isPathSeparator =
      character === "/" || character === "\\" || codePoint <= 31 || codePoint === 127;
    if (isPathSeparator) {
      if (!replacingPathSeparator) pathSafeTitle += "-";
      replacingPathSeparator = true;
      continue;
    }
    pathSafeTitle += character;
    replacingPathSeparator = false;
  }

  const normalized = pathSafeTitle
    .replace(/\s+/gu, " ")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .trim();
  return normalized === "." || normalized === ".." ? "" : normalized;
}

export function isWorkComplexity(value: unknown): value is WorkComplexity {
  return value === "simple" || value === "normal" || value === "hard";
}

export const WORK_COMPLEXITY_OPTIONS: ReadonlyArray<{
  readonly value: WorkComplexity;
  readonly label: string;
}> = [
  { value: "simple", label: "Simple tasks" },
  { value: "normal", label: "Normal work" },
  { value: "hard", label: "Hard work" },
];

interface WorkModelPreset {
  readonly model: string;
  readonly reasoningEffort: "low" | "high";
}

export const WORK_MODEL_PRESETS: Readonly<Record<WorkComplexity, WorkModelPreset>> = {
  simple: { model: "gpt-5.6-luna", reasoningEffort: "high" },
  normal: { model: "gpt-5.6-sol", reasoningEffort: "low" },
  hard: { model: "gpt-5.6-sol", reasoningEffort: "high" },
};

export function resolveWorkCodexInstance(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  preferredInstanceId: ProviderInstanceId | null | undefined,
): ProviderInstanceEntry | undefined {
  const codexEntries = entries.filter((entry) => entry.driverKind === WORK_CODEX_DRIVER);
  const preferredCodexInstanceId = codexEntries.find(
    (entry) => entry.instanceId === preferredInstanceId,
  )?.instanceId;
  return resolveSelectableProviderInstanceEntry(
    codexEntries,
    preferredCodexInstanceId ?? DEFAULT_WORK_CODEX_INSTANCE_ID,
  );
}

export function createWorkModelSelection(
  complexity: WorkComplexity,
  instanceId: ProviderInstanceId = DEFAULT_WORK_CODEX_INSTANCE_ID,
): ModelSelection {
  const preset = WORK_MODEL_PRESETS[complexity];
  return createModelSelection(instanceId, preset.model, [
    { id: "reasoningEffort", value: preset.reasoningEffort },
  ]);
}

/**
 * Matches the model and reasoning dimensions owned by the Work control.
 * Provider options such as service tier do not change task complexity.
 */
export function resolveWorkComplexity(
  selection: ModelSelection | null | undefined,
  instanceId: ProviderInstanceId = DEFAULT_WORK_CODEX_INSTANCE_ID,
): WorkComplexity | null {
  if (!selection || selection.instanceId !== instanceId) {
    return null;
  }

  const reasoningEffort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  return (
    WORK_COMPLEXITIES.find((complexity) => {
      const preset = WORK_MODEL_PRESETS[complexity];
      return selection.model === preset.model && reasoningEffort === preset.reasoningEffort;
    }) ?? null
  );
}
