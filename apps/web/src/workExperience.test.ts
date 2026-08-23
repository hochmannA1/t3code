import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkModelSelection,
  DEFAULT_WORK_COMPLEXITY,
  isStandaloneWorkProject,
  resolveWorkComplexity,
  resolveWorkCodexInstance,
  workProjectDirectoryName,
  WORK_MODEL_PRESETS,
  type WorkComplexity,
} from "./workExperience";
import type { ProviderInstanceEntry } from "./providerInstances";

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const SECOND_CODEX_INSTANCE_ID = ProviderInstanceId.make("codex_work");

function providerEntry(
  instanceId: ProviderInstanceId,
  driverKind: ProviderInstanceEntry["driverKind"],
): ProviderInstanceEntry {
  return {
    instanceId,
    driverKind,
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: String(instanceId) === String(driverKind),
    isAvailable: true,
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    models: [],
  };
}

describe("Work model presets", () => {
  it("uses Normal work by default", () => {
    expect(DEFAULT_WORK_COMPLEXITY).toBe("normal");
  });

  it.each<[WorkComplexity, string, string]>([
    ["simple", "gpt-5.6-luna", "high"],
    ["normal", "gpt-5.6-sol", "low"],
    ["hard", "gpt-5.6-sol", "high"],
  ])("maps %s work to its Codex selection", (complexity, model, reasoningEffort) => {
    expect(WORK_MODEL_PRESETS[complexity]).toEqual({ model, reasoningEffort });
    expect(createWorkModelSelection(complexity)).toEqual({
      instanceId: CODEX_INSTANCE_ID,
      model,
      options: [{ id: "reasoningEffort", value: reasoningEffort }],
    });
  });

  it("resolves exact model and reasoning matches", () => {
    expect(resolveWorkComplexity(createWorkModelSelection("simple"))).toBe("simple");
    expect(resolveWorkComplexity(createWorkModelSelection("normal"))).toBe("normal");
    expect(resolveWorkComplexity(createWorkModelSelection("hard"))).toBe("hard");
  });

  it("matches a configured Codex instance when the caller supplies it", () => {
    const selection = createWorkModelSelection("hard", SECOND_CODEX_INSTANCE_ID);

    expect(resolveWorkComplexity(selection)).toBeNull();
    expect(resolveWorkComplexity(selection, SECOND_CODEX_INSTANCE_ID)).toBe("hard");
  });

  it("ignores provider options that do not change complexity", () => {
    const presetSelection = createWorkModelSelection("normal");
    const selection = {
      ...presetSelection,
      options: [...(presetSelection.options ?? []), { id: "serviceTier", value: "fast" }],
    };

    expect(resolveWorkComplexity(selection)).toBe("normal");
  });

  it("returns null for selections outside the Work presets", () => {
    expect(
      resolveWorkComplexity({
        instanceId: CODEX_INSTANCE_ID,
        model: "gpt-5.6-sol",
      }),
    ).toBeNull();
    expect(
      resolveWorkComplexity({
        instanceId: CODEX_INSTANCE_ID,
        model: "gpt-5.6-terra",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBeNull();
    expect(resolveWorkComplexity(null)).toBeNull();
  });

  it("selects Codex even when another provider was previously active", () => {
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const entries = [
      providerEntry(claudeInstanceId, ProviderDriverKind.make("claudeAgent")),
      providerEntry(CODEX_INSTANCE_ID, ProviderDriverKind.make("codex")),
      providerEntry(SECOND_CODEX_INSTANCE_ID, ProviderDriverKind.make("codex")),
    ];

    expect(resolveWorkCodexInstance(entries, claudeInstanceId)?.instanceId).toBe(CODEX_INSTANCE_ID);
    expect(resolveWorkCodexInstance(entries, SECOND_CODEX_INSTANCE_ID)?.instanceId).toBe(
      SECOND_CODEX_INSTANCE_ID,
    );
  });

  it("does not fall back to another provider when Codex is unavailable", () => {
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    expect(
      resolveWorkCodexInstance(
        [providerEntry(claudeInstanceId, ProviderDriverKind.make("claudeAgent"))],
        claudeInstanceId,
      ),
    ).toBeUndefined();
  });
});

describe("workProjectDirectoryName", () => {
  it("keeps readable titles while removing path separators", () => {
    expect(workProjectDirectoryName("  Quarterly Review 2026  ")).toBe("Quarterly Review 2026");
    expect(workProjectDirectoryName("Sales / Europe\\Q3")).toBe("Sales - Europe-Q3");
    expect(workProjectDirectoryName("..")).toBe("");
  });
});

describe("isStandaloneWorkProject", () => {
  it("recognizes task workspaces allocated below a dated directory", () => {
    expect(
      isStandaloneWorkProject({
        title: "prepare-quarterly-report",
        workspaceRoot: "/home/user/t3work/projects/2026-08-23/prepare-quarterly-report",
      }),
    ).toBe(true);
    expect(
      isStandaloneWorkProject({
        title: "prepare-quarterly-report",
        workspaceRoot: "C:\\Users\\user\\t3work\\projects\\2026-08-23\\prepare-quarterly-report",
      }),
    ).toBe(true);
  });

  it("keeps named and mismatched projects in the Projects section", () => {
    expect(
      isStandaloneWorkProject({
        title: "Quarterly Planning",
        workspaceRoot: "/home/user/t3work/projects/Quarterly Planning",
      }),
    ).toBe(false);
    expect(
      isStandaloneWorkProject({
        title: "Renamed task",
        workspaceRoot: "/home/user/t3work/projects/2026-08-23/original-task",
      }),
    ).toBe(false);
    expect(
      isStandaloneWorkProject({
        title: "Quarterly Planning",
        workspaceRoot: "/home/user/client-files/2026-08-23/Quarterly Planning",
      }),
    ).toBe(false);
  });
});
