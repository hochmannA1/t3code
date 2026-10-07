import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import {
  memoryCliFailureDetail,
  buildMemoryPrompt,
  MEMORY_SOURCE_CHAR_BUDGET,
  MemoryGenerationResult,
  validateMemorySources,
  unsupportedMemoryGeneration,
} from "./MemoryGeneration.ts";
import { toJsonSchemaObject } from "./TextGenerationUtils.ts";

const input = {
  cwd: "/project",
  modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna"),
  mode: "extract" as const,
  sources: [{ id: "thread:1", text: "The user prefers focused tests." }],
};
const entry = {
  title: "Tests",
  text: "Use focused tests.",
  scope: "personal" as const,
  keywords: ["tests"],
  sourceIds: ["thread:1"],
};

describe("memory generation", () => {
  it("keeps structured CLI errors without leaking echoed transcript content", () => {
    const stderr =
      'user\nprivate transcript text\nERROR: {\n  "error": { "message": "Model unavailable", "type": "invalid_request" }\n}\ntrailing diagnostic';
    expect(memoryCliFailureDetail("Codex", stderr, 1)).toBe(
      "Codex memory request failed: Model unavailable",
    );
    expect(memoryCliFailureDetail("Codex", "private transcript text", 2)).toBe(
      "Codex memory request failed with code 2.",
    );
    expect(
      memoryCliFailureDetail("Claude", "Error: authentication failed\nprivate transcript text", 1),
    ).toBe("Claude memory request failed: authentication failed");
  });

  it("emits a provider schema without unsupported refinement composition", () => {
    const schema = JSON.stringify(toJsonSchemaObject(buildMemoryPrompt(input).outputSchema));
    expect(schema).not.toContain('"allOf"');
  });

  it("bounds evidence while retaining only IDs actually supplied to the model", () => {
    const result = buildMemoryPrompt({
      ...input,
      sources: [
        { id: "large", text: "x".repeat(MEMORY_SOURCE_CHAR_BUDGET + 10) },
        { id: "omitted", text: "not sent" },
      ],
    });
    expect(result.sourceIds).toEqual(["large"]);
    expect(result.prompt).not.toContain("not sent");
    const evidence = JSON.parse(result.prompt.split("Evidence (JSON data):\n\n")[1]!);
    expect(evidence[0].text.length).toBe(MEMORY_SOURCE_CHAR_BUDGET);
  });

  it("gives extraction, daily consolidation, and weekly dreaming distinct jobs", () => {
    const extract = buildMemoryPrompt(input).prompt;
    const consolidate = buildMemoryPrompt({ ...input, mode: "consolidate" }).prompt;
    const dream = buildMemoryPrompt({ ...input, mode: "dream" }).prompt;
    expect(extract).toContain("Extract only durable, useful knowledge");
    expect(consolidate).toContain("daily consolidation");
    expect(dream).toContain("deeper weekly review");
  });

  it("permits no-signal results and rejects oversized or uncited records", () => {
    const decode = Schema.decodeSync(MemoryGenerationResult);
    expect(decode({ entries: [] })).toEqual({ entries: [] });
    expect(() => decode({ entries: [{ ...entry, text: "x".repeat(4001) }] })).toThrow();
    expect(() => decode({ entries: [{ ...entry, sourceIds: [] }] })).toThrow();
  });

  it.effect("rejects invented citations", () =>
    Effect.gen(function* () {
      const valid = yield* validateMemorySources({ entries: [entry] }, ["thread:1"]);
      expect(valid.entries).toHaveLength(1);
      const invalid = yield* validateMemorySources({ entries: [entry] }, ["thread:2"]).pipe(
        Effect.result,
      );
      expect(Result.isFailure(invalid)).toBe(true);
    }),
  );

  it.effect("unsupported providers fail without running a provider", () =>
    Effect.gen(function* () {
      const result = yield* unsupportedMemoryGeneration("Cursor")().pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
