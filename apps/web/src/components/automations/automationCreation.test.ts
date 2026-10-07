import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_CHAT_STARTER_PROMPT,
  AUTOMATION_PROMPT_STARTERS,
  automationNameFromPrompt,
  automationTimezones,
} from "./automationCreation";

describe("automation creation starters", () => {
  it("starts chat creation with an editable request that asks for confirmation", () => {
    expect(AUTOMATION_CHAT_STARTER_PROMPT).toContain("Ask what it should do and when");
    expect(AUTOMATION_CHAT_STARTER_PROMPT).toContain("once I confirm");
  });

  it("offers concise, complete manual prompt starters", () => {
    expect(AUTOMATION_PROMPT_STARTERS).toHaveLength(4);
    for (const starter of AUTOMATION_PROMPT_STARTERS) {
      expect(starter.label.length).toBeLessThanOrEqual(24);
      expect(starter.name.trim()).not.toBe("");
      expect(starter.prompt.trim().length).toBeGreaterThan(40);
    }
  });

  it("derives a short fallback name from the prompt", () => {
    expect(automationNameFromPrompt("  Review project health every morning.\nIgnore drafts.")).toBe(
      "Review project health every morning",
    );
    expect(automationNameFromPrompt("")).toBe("New automation");
    expect(automationNameFromPrompt("x".repeat(80))).toBe(`${"x".repeat(53)}...`);
  });

  it("offers the current timezone and UTC as selectable values", () => {
    const timezones = automationTimezones("Europe/Vienna");

    expect(timezones).toContain("Europe/Vienna");
    expect(timezones).toContain("UTC");
    expect(new Set(timezones).size).toBe(timezones.length);
  });
});
