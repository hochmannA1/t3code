import { describe, expect, it } from "@effect/vitest";

import { automationMirrorRetryAt, automationMirrorUrl } from "./AutomationMirror.ts";

describe("automation coordinator mirror", () => {
  it("builds the agreed coordinator route without duplicating slashes", () => {
    expect(automationMirrorUrl("https://hub.example/api/tools/", "daily/report")).toBe(
      "https://hub.example/api/tools/automations/daily%2Freport",
    );
  });

  it("backs off failed deliveries and caps the delay at five minutes", () => {
    expect(automationMirrorRetryAt("2026-08-23T10:00:00.000Z", 0)).toBe("2026-08-23T10:00:01.000Z");
    expect(automationMirrorRetryAt("2026-08-23T10:00:00.000Z", 20)).toBe(
      "2026-08-23T10:05:00.000Z",
    );
  });
});
