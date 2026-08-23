import { expect, it } from "@effect/vitest";
import {
  AutomationId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Automation,
  type AutomationCreateInput,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AutomationService from "../../../automation/AutomationService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { makeAutomationToolkitHandlers } from "./handlers.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const automationId = AutomationId.make("automation-1");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
} as ModelSelection;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["automations"]),
  issuedAt: 1,
};

const thread = {
  id: threadId,
  projectId,
  modelSelection,
  interactionMode: "default",
  branch: "feat/current-task",
  worktreePath: "/workspace/current-task",
} as never;

const automation = {
  automationId,
  projectId,
  name: "Daily status",
  prompt: "Summarize the project",
} as Automation;

const unsupported = () => Effect.die("not used in this test");

function service(
  overrides: Partial<AutomationService.AutomationServiceShape>,
): AutomationService.AutomationServiceShape {
  return {
    list: unsupported,
    get: unsupported,
    create: unsupported,
    update: unsupported,
    remove: unsupported,
    pause: unsupported,
    resume: unsupported,
    runNow: unsupported,
    listRuns: unsupported,
    dispatchRemote: unsupported,
    getRunStatus: unsupported,
    tick: unsupported,
    ...overrides,
  };
}

function handlers(automationService: AutomationService.AutomationServiceShape) {
  return makeAutomationToolkitHandlers(
    automationService,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
      getThreadShellById: () => Effect.succeed(Option.some(thread)),
    } as never),
  );
}

const provideScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

it.effect("lists only the current task's project", () => {
  let requestedProject: ProjectId | undefined;
  return Effect.gen(function* () {
    const result = yield* provideScope(
      handlers(
        service({
          list: (input) => {
            requestedProject = input.projectId;
            return Effect.succeed([automation]);
          },
        }),
      ).automation_list(),
    );

    expect(requestedProject).toBe(projectId);
    expect(result.automations).toEqual([automation]);
  });
});

it.effect("captures unattended execution settings from the current task", () => {
  let created: AutomationCreateInput | undefined;
  return Effect.gen(function* () {
    yield* provideScope(
      handlers(
        service({
          create: (input) => {
            created = input;
            return Effect.succeed(automation);
          },
        }),
      ).automation_create({
        name: "Daily status",
        prompt: "Summarize the project",
        schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Vienna" },
        destination: "same-task",
      }),
    );

    expect(created).toMatchObject({
      projectId,
      destination: { kind: "same-thread", threadId },
      execution: {
        modelSelection,
        runtimeMode: "full-access",
        approvalPolicy: "never",
        interactionMode: "default",
        responseProfile: "work",
        branch: "feat/current-task",
        worktreePath: "/workspace/current-task",
      },
    });
  });
});

it.effect("does not reveal an automation from another project", () =>
  Effect.gen(function* () {
    const error = yield* provideScope(
      handlers(
        service({
          get: () =>
            Effect.succeed({ ...automation, projectId: ProjectId.make("project-2") } as Automation),
        }),
      ).automation_get({ automationId }),
    ).pipe(Effect.flip);

    expect(error).toMatchObject({ code: "not-found" });
  }),
);
