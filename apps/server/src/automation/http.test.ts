import { describe, expect, it } from "@effect/vitest";

import { constantTimeTokenEqual } from "./http.ts";

describe("automation internal route authentication", () => {
  it("accepts only the exact configured dispatch token", () => {
    expect(constantTimeTokenEqual("coordinator-secret", "coordinator-secret")).toBe(true);
    expect(constantTimeTokenEqual("coordinator-secreu", "coordinator-secret")).toBe(false);
    expect(constantTimeTokenEqual("coordinator-secret-extra", "coordinator-secret")).toBe(false);
    expect(constantTimeTokenEqual("", "coordinator-secret")).toBe(false);
  });
});
