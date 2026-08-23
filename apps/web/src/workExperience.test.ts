import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkModelSelection,
  DEFAULT_WORK_COMPLEXITY,
  resolveWorkComplexity,
  workProjectDirectoryName,
  WORK_MODEL_PRESETS,
  type WorkComplexity,
} from "./workExperience";

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const SECOND_CODEX_INSTANCE_ID = ProviderInstanceId.make("codex_work");

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
});

describe("workProjectDirectoryName", () => {
  it("keeps readable titles while removing path separators", () => {
    expect(workProjectDirectoryName("  Quarterly Review 2026  ")).toBe("Quarterly Review 2026");
    expect(workProjectDirectoryName("Sales / Europe\\Q3")).toBe("Sales - Europe-Q3");
    expect(workProjectDirectoryName("..")).toBe("");
  });
});
