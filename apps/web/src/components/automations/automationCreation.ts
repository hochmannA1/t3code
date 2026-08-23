export const AUTOMATION_CHAT_STARTER_PROMPT =
  "Help me create an automation for this project. Ask what it should do and when it should run. Keep the setup simple, suggest sensible defaults, and create it once I confirm.";

export function automationNameFromPrompt(prompt: string): string {
  const firstLine = prompt
    .trim()
    .split(/\r?\n/u, 1)[0]
    ?.replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "")
    .trim();
  if (!firstLine) return "New automation";
  return firstLine.length <= 56 ? firstLine : `${firstLine.slice(0, 53).trimEnd()}...`;
}

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Vienna",
  "Asia/Tokyo",
] as const;

export function automationTimezones(currentTimezone: string): ReadonlyArray<string> {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => Array<string>;
  };
  const supported = intl.supportedValuesOf?.("timeZone") ?? [...FALLBACK_TIMEZONES];
  return Array.from(new Set([currentTimezone, "UTC", ...supported].filter(Boolean)));
}

export const AUTOMATION_PROMPT_STARTERS = [
  {
    label: "Daily project check",
    name: "Daily project check",
    prompt:
      "Review the current project each morning. Summarize what changed, what is blocked, and the most useful next step.",
  },
  {
    label: "Weekly progress summary",
    name: "Weekly progress summary",
    prompt:
      "Summarize this week's project progress, important decisions, open risks, and the priorities for next week.",
  },
  {
    label: "Keep docs current",
    name: "Documentation check",
    prompt:
      "Review recent project changes for documentation that is missing or out of date. Update the relevant docs and summarize what changed.",
  },
  {
    label: "Check project health",
    name: "Project health check",
    prompt:
      "Check the project for failing tests, stale dependencies, and unfinished work. Report only items that need attention.",
  },
] as const;
