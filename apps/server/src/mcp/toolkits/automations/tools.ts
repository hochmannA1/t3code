import {
  Automation,
  AutomationDeleteResult,
  AutomationError,
  AutomationId,
  AutomationListResult,
  AutomationListRunsResult,
  AutomationRun,
  AutomationSchedule,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const AutomationIdInput = Schema.Struct({ automationId: AutomationId });

export const AutomationCreateFromTaskInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  schedule: AutomationSchedule,
  destination: Schema.optionalKey(Schema.Literals(["same-task", "new-task"])),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type AutomationCreateFromTaskInput = typeof AutomationCreateFromTaskInput.Type;

export const AutomationUpdateFromTaskInput = Schema.Struct({
  automationId: AutomationId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  prompt: Schema.optionalKey(TrimmedNonEmptyString),
  schedule: Schema.optionalKey(AutomationSchedule),
  destination: Schema.optionalKey(Schema.Literals(["same-task", "new-task"])),
});
export type AutomationUpdateFromTaskInput = typeof AutomationUpdateFromTaskInput.Type;

const AutomationListRunsFromTaskInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

const mutationTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.Readonly, false).annotate(Tool.OpenWorld, false) as T;

export const AutomationListTool = readonlyTool(
  Tool.make("automation_list", {
    description:
      "List scheduled prompt automations for this task's project. Results never include automations from another project.",
    parameters: Schema.Struct({}),
    success: AutomationListResult,
    failure: AutomationError,
    dependencies,
  }).annotate(Tool.Title, "List automations"),
);

export const AutomationGetTool = readonlyTool(
  Tool.make("automation_get", {
    description: "Inspect one scheduled prompt automation in this task's project.",
    parameters: AutomationIdInput,
    success: Automation,
    failure: AutomationError,
    dependencies,
  }).annotate(Tool.Title, "Get automation"),
);

export const AutomationCreateTool = mutationTool(
  Tool.make("automation_create", {
    description:
      "Create a scheduled prompt automation for this task's project. The current task's model, reasoning mode, branch, and workspace are captured automatically. Omit enabled, or set it to true, when the user explicitly requested the automation. Set enabled=false only for an unsolicited suggestion that the user still needs to accept.",
    parameters: AutomationCreateFromTaskInput,
    success: Automation,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Create automation")
    .annotate(Tool.Destructive, true),
);

export const AutomationUpdateTool = mutationTool(
  Tool.make("automation_update", {
    description:
      "Change an automation in this task's project. Omitted fields keep their current values. Setting destination to same-task moves future runs to this task.",
    parameters: AutomationUpdateFromTaskInput,
    success: Automation,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Update automation")
    .annotate(Tool.Destructive, true),
);

export const AutomationPauseTool = mutationTool(
  Tool.make("automation_pause", {
    description: "Pause an automation in this task's project. Paused automations do not run.",
    parameters: AutomationIdInput,
    success: Automation,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Pause automation")
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
);

export const AutomationResumeTool = mutationTool(
  Tool.make("automation_resume", {
    description:
      "Resume a paused repeating automation in this task's project. A completed one-time automation cannot be resumed.",
    parameters: AutomationIdInput,
    success: Automation,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resume automation")
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
);

export const AutomationDeleteTool = mutationTool(
  Tool.make("automation_delete", {
    description: "Permanently delete an automation and its run history from this task's project.",
    parameters: AutomationIdInput,
    success: AutomationDeleteResult,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Delete automation")
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
);

export const AutomationRunTool = mutationTool(
  Tool.make("automation_run", {
    description:
      "Start one manual run of an automation in this task's project now. This does not change its schedule.",
    parameters: AutomationIdInput,
    success: AutomationRun,
    failure: AutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Run automation now")
    .annotate(Tool.Destructive, true),
);

export const AutomationListRunsTool = readonlyTool(
  Tool.make("automation_list_runs", {
    description: "List the latest runs and failures for an automation in this task's project.",
    parameters: AutomationListRunsFromTaskInput,
    success: AutomationListRunsResult,
    failure: AutomationError,
    dependencies,
  }).annotate(Tool.Title, "List automation runs"),
);

export const AutomationToolkit = Toolkit.make(
  AutomationListTool,
  AutomationGetTool,
  AutomationCreateTool,
  AutomationUpdateTool,
  AutomationPauseTool,
  AutomationResumeTool,
  AutomationDeleteTool,
  AutomationRunTool,
  AutomationListRunsTool,
);
