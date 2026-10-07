import {
  IsoDateTime,
  type Automation,
  type AutomationRun,
  type AutomationSchedule,
} from "@t3tools/contracts";

export type AutomationFilter = "all" | "active" | "paused";
export type AutomationScheduleChoice =
  | "once"
  | "interval"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export interface AutomationScheduleDraft {
  readonly choice: AutomationScheduleChoice;
  readonly onceAt: string;
  readonly everyValue: string;
  readonly everyUnit: "minutes" | "hours" | "days";
  readonly startsAt: string;
  readonly time: string;
  readonly weekday: string;
  readonly cronExpression: string;
  readonly timezone: string;
}

const DAILY_CRON = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/u;
const WEEKDAYS_CRON = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/u;
const WEEKLY_CRON = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])$/u;

const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function localDateTimeValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function timeParts(value: string): { readonly hour: number; readonly minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function cronTime(match: RegExpExecArray): string {
  return `${String(Number(match[2])).padStart(2, "0")}:${String(Number(match[1])).padStart(2, "0")}`;
}

export function defaultAutomationScheduleDraft(now = new Date()): AutomationScheduleDraft {
  const nextHour = new Date(now);
  nextHour.setSeconds(0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  return {
    choice: "daily",
    onceAt: localDateTimeValue(nextHour),
    everyValue: "1",
    everyUnit: "hours",
    startsAt: localDateTimeValue(nextHour),
    time: "09:00",
    weekday: "1",
    cronExpression: "0 9 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export function automationScheduleDraft(
  schedule: AutomationSchedule,
  now = new Date(),
): AutomationScheduleDraft {
  const fallback = defaultAutomationScheduleDraft(now);
  if (schedule.kind === "once") {
    return { ...fallback, choice: "once", onceAt: localDateTimeValue(new Date(schedule.at)) };
  }
  if (schedule.kind === "interval") {
    const everyUnit =
      schedule.everyMinutes % 1_440 === 0
        ? "days"
        : schedule.everyMinutes % 60 === 0
          ? "hours"
          : "minutes";
    const divisor = everyUnit === "days" ? 1_440 : everyUnit === "hours" ? 60 : 1;
    return {
      ...fallback,
      choice: "interval",
      everyValue: String(schedule.everyMinutes / divisor),
      everyUnit,
      startsAt: localDateTimeValue(new Date(schedule.startsAt)),
    };
  }

  const weekdays = WEEKDAYS_CRON.exec(schedule.expression);
  if (weekdays) {
    return {
      ...fallback,
      choice: "weekdays",
      time: cronTime(weekdays),
      timezone: schedule.timezone,
    };
  }
  const weekly = WEEKLY_CRON.exec(schedule.expression);
  if (weekly) {
    return {
      ...fallback,
      choice: "weekly",
      time: cronTime(weekly),
      weekday: weekly[3] ?? "1",
      timezone: schedule.timezone,
    };
  }
  const daily = DAILY_CRON.exec(schedule.expression);
  if (daily) {
    return {
      ...fallback,
      choice: "daily",
      time: cronTime(daily),
      timezone: schedule.timezone,
    };
  }
  return {
    ...fallback,
    choice: "custom",
    cronExpression: schedule.expression,
    timezone: schedule.timezone,
  };
}

export function buildAutomationSchedule(draft: AutomationScheduleDraft): {
  readonly schedule: AutomationSchedule | null;
  readonly error: string | null;
} {
  if (draft.choice === "once") {
    const at = new Date(draft.onceAt);
    if (!draft.onceAt || Number.isNaN(at.getTime())) {
      return { schedule: null, error: "Choose when this automation should run." };
    }
    return { schedule: { kind: "once", at: IsoDateTime.make(at.toISOString()) }, error: null };
  }

  if (draft.choice === "interval") {
    const amount = Number(draft.everyValue);
    const startsAt = new Date(draft.startsAt);
    if (!Number.isInteger(amount) || amount < 1) {
      return { schedule: null, error: "Enter a whole number greater than zero." };
    }
    if (!draft.startsAt || Number.isNaN(startsAt.getTime())) {
      return { schedule: null, error: "Choose when the repeating schedule should start." };
    }
    const multiplier = draft.everyUnit === "days" ? 1_440 : draft.everyUnit === "hours" ? 60 : 1;
    return {
      schedule: {
        kind: "interval",
        everyMinutes: amount * multiplier,
        startsAt: IsoDateTime.make(startsAt.toISOString()),
      },
      error: null,
    };
  }

  if (!draft.timezone.trim()) {
    return { schedule: null, error: "Choose a timezone." };
  }
  if (draft.choice === "custom") {
    const expression = draft.cronExpression.trim();
    if (!expression) {
      return { schedule: null, error: "Enter a custom schedule." };
    }
    return {
      schedule: { kind: "cron", expression, timezone: draft.timezone.trim() },
      error: null,
    };
  }

  const time = timeParts(draft.time);
  if (!time) {
    return { schedule: null, error: "Choose a valid time." };
  }
  const prefix = `${time.minute} ${time.hour} * *`;
  const expression =
    draft.choice === "weekdays"
      ? `${prefix} 1-5`
      : draft.choice === "weekly"
        ? `${prefix} ${draft.weekday}`
        : `${prefix} *`;
  return {
    schedule: { kind: "cron", expression, timezone: draft.timezone.trim() },
    error: null,
  };
}

export function automationScheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === "once") {
    return `Once, ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(schedule.at))}`;
  }
  if (schedule.kind === "interval") {
    const [amount, unit] =
      schedule.everyMinutes % 1_440 === 0
        ? [schedule.everyMinutes / 1_440, "day"]
        : schedule.everyMinutes % 60 === 0
          ? [schedule.everyMinutes / 60, "hour"]
          : [schedule.everyMinutes, "minute"];
    return `Every ${amount} ${unit}${amount === 1 ? "" : "s"}`;
  }
  const draft = automationScheduleDraft(schedule);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(`2000-01-01T${draft.time}:00`));
  switch (draft.choice) {
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `Every ${WEEKDAY_LABELS[Number(draft.weekday)] ?? "week"} at ${time}`;
    case "custom":
      return "Custom schedule";
    default:
      return "Scheduled";
  }
}

export function automationNextRunLabel(nextRunAt: string | null): string {
  if (!nextRunAt) return "No upcoming run";
  return `Next ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(nextRunAt))}`;
}

export function filterAutomations(
  automations: ReadonlyArray<Automation>,
  filter: AutomationFilter,
  query: string,
  projectTitleById: ReadonlyMap<string, string>,
): Automation[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return automations.filter((automation) => {
    if (filter !== "all" && automation.status !== filter) return false;
    if (!normalizedQuery) return true;
    return [automation.name, automation.prompt, projectTitleById.get(automation.projectId) ?? ""]
      .join("\n")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
}

export function automationRunLabel(run: AutomationRun): string {
  switch (run.status) {
    case "pending":
      return "Waiting to start";
    case "waiting-for-thread":
      return "Waiting for the task to finish";
    case "running":
      return "Running";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

export function automationPausedReasonLabel(automation: Automation): string | null {
  if (automation.status !== "paused") return null;
  switch (automation.pausedReason) {
    case "three-consecutive-failures":
      return "Paused after three failed runs";
    case "one-time-completed":
      return "Finished its one-time run";
    case "user":
    case null:
      return "Paused";
  }
}

export function automationCanResume(automation: Automation): boolean {
  return automation.status === "paused" && automation.pausedReason !== "one-time-completed";
}
