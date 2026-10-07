// @effect-diagnostics globalDate:off -- Intl cron matching needs JavaScript Date instances.
import type { AutomationSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const MAX_SCAN_MINUTES = 5 * 366 * 24 * 60;

type CronField = {
  readonly values: ReadonlySet<number>;
  readonly unrestricted: boolean;
};

type ParsedCron = {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
};

export class ScheduleValidationError extends Error {}

function parseDate(value: string, label: string): Date {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new ScheduleValidationError(`${label} must be a valid date and time.`);
  }
  return new Date(millis);
}

function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
  } catch {
    throw new ScheduleValidationError(`Unknown timezone: ${timezone}`);
  }
}

function parseNumber(raw: string, minimum: number, maximum: number, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ScheduleValidationError(`${label} contains an invalid value: ${raw}`);
  }
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new ScheduleValidationError(`${label} values must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseCronField(
  raw: string,
  minimum: number,
  maximum: number,
  label: string,
  normalize: (value: number) => number = (value) => value,
): CronField {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangeRaw, stepRaw, ...extra] = part.split("/");
    if (rangeRaw === undefined || extra.length > 0 || rangeRaw === "") {
      throw new ScheduleValidationError(`${label} contains an invalid value: ${part}`);
    }
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, 1, maximum - minimum + 1, label);
    let start: number;
    let end: number;
    if (rangeRaw === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeRaw.includes("-")) {
      const [startRaw, endRaw, ...rangeExtra] = rangeRaw.split("-");
      if (startRaw === undefined || endRaw === undefined || rangeExtra.length > 0) {
        throw new ScheduleValidationError(`${label} contains an invalid range: ${rangeRaw}`);
      }
      start = parseNumber(startRaw, minimum, maximum, label);
      end = parseNumber(endRaw, minimum, maximum, label);
      if (end < start) {
        throw new ScheduleValidationError(`${label} ranges must start before they end.`);
      }
    } else {
      start = parseNumber(rangeRaw, minimum, maximum, label);
      end = start;
      if (stepRaw !== undefined) {
        throw new ScheduleValidationError(`${label} steps require * or a range.`);
      }
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize(value));
    }
  }
  return { values, unrestricted: raw === "*" };
}

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleValidationError("Cron schedules need five fields.");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new ScheduleValidationError("Cron schedules need five fields.");
  }
  return {
    minute: parseCronField(minute, 0, 59, "Minute"),
    hour: parseCronField(hour, 0, 23, "Hour"),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31, "Day of month"),
    month: parseCronField(month, 1, 12, "Month"),
    dayOfWeek: parseCronField(dayOfWeek, 0, 7, "Day of week", (value) => value % 7),
  };
}

const WEEKDAY_NUMBER = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
} as const;

function cronParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-iso8601", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAY_NUMBER[parts.weekday as keyof typeof WEEKDAY_NUMBER];
  if (weekday === undefined) {
    throw new ScheduleValidationError(`Could not calculate a date in timezone ${timezone}.`);
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
}

function matchesCron(date: Date, timezone: string, cron: ParsedCron): boolean {
  const parts = cronParts(date, timezone);
  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches =
    cron.dayOfMonth.unrestricted || cron.dayOfWeek.unrestricted
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    cron.month.values.has(parts.month) &&
    dayMatches
  );
}

export function validateAutomationSchedule(schedule: AutomationSchedule): void {
  switch (schedule.kind) {
    case "once":
      parseDate(schedule.at, "Run time");
      return;
    case "interval":
      parseDate(schedule.startsAt, "Start time");
      if (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 1) {
        throw new ScheduleValidationError("Repeat interval must be at least one minute.");
      }
      return;
    case "cron":
      assertTimeZone(schedule.timezone);
      parseCron(schedule.expression);
  }
}

export function firstAutomationOccurrence(
  schedule: AutomationSchedule,
  now: Date | string,
): string | null {
  validateAutomationSchedule(schedule);
  const nowDate = typeof now === "string" ? parseDate(now, "Current time") : now;
  switch (schedule.kind) {
    case "once":
      return parseDate(schedule.at, "Run time").toISOString();
    case "interval": {
      const startsAt = parseDate(schedule.startsAt, "Start time").getTime();
      if (startsAt > nowDate.getTime()) return new Date(startsAt).toISOString();
      const intervalMs = schedule.everyMinutes * MINUTE_MS;
      const elapsed = nowDate.getTime() - startsAt;
      return new Date(startsAt + Math.floor(elapsed / intervalMs) * intervalMs).toISOString();
    }
    case "cron":
      return nextAutomationOccurrence(schedule, nowDate);
  }
}

export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  after: Date | string,
): string | null {
  validateAutomationSchedule(schedule);
  const afterDate = typeof after === "string" ? parseDate(after, "Current time") : after;
  switch (schedule.kind) {
    case "once": {
      const at = parseDate(schedule.at, "Run time");
      return at.getTime() > afterDate.getTime() ? at.toISOString() : null;
    }
    case "interval": {
      const startsAt = parseDate(schedule.startsAt, "Start time").getTime();
      const intervalMs = schedule.everyMinutes * MINUTE_MS;
      if (startsAt > afterDate.getTime()) return new Date(startsAt).toISOString();
      const elapsed = afterDate.getTime() - startsAt;
      return new Date(startsAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs).toISOString();
    }
    case "cron": {
      const cron = parseCron(schedule.expression);
      let candidateMs = Math.floor(afterDate.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
      for (let index = 0; index < MAX_SCAN_MINUTES; index += 1) {
        const candidate = new Date(candidateMs);
        if (matchesCron(candidate, schedule.timezone, cron)) return candidate.toISOString();
        candidateMs += MINUTE_MS;
      }
      throw new ScheduleValidationError("Cron schedule has no occurrence in the next five years.");
    }
  }
}
