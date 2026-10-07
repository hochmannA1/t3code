import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MemoryGetRecommendationsInput, MemoryGetRecommendationsResult } from "./memory.ts";

describe("memory recommendation contracts", () => {
  it("requires an explicit projectless or project scope", () => {
    const decode = Schema.decodeUnknownSync(MemoryGetRecommendationsInput);
    expect(decode({ projectId: null })).toEqual({ projectId: null });
    expect(decode({ projectId: "project-1", refresh: true })).toEqual({ projectId: "project-1" });
    expect(() => decode({})).toThrow();
  });

  it("accepts typed suggestions and rejects more than two", () => {
    const decode = Schema.decodeUnknownSync(MemoryGetRecommendationsResult);
    const recommendation = {
      id: "memory-recommendation",
      type: "task",
      label: "Review storage",
      prompt: "Review the current storage setup.",
    };
    expect(decode({ recommendations: [recommendation] })).toEqual({
      recommendations: [recommendation],
      retryable: false,
    });
    expect(decode({ recommendations: [], retryable: true }).retryable).toBe(true);
    expect(() =>
      decode({ recommendations: [recommendation, recommendation, recommendation] }),
    ).toThrow();
    expect(() => decode({ recommendations: [{ ...recommendation, type: "unknown" }] })).toThrow();
  });
});
