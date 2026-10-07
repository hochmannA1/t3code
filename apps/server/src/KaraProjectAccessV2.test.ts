import { expect, it } from "@effect/vitest";
import {
  isAllowedSharedProjectCommand,
  isSafeSharedProjectRelativePath,
} from "./KaraProjectAccessV2.ts";
import type { ProjectGrant } from "./KaraProjectGrant.ts";

const grant: ProjectGrant = {
  v: 1,
  shareId: "11111111-1111-4111-8111-111111111111",
  projectId: "project-shared",
  subject: "collaborator",
  tenant: "tenant-a",
  role: "edit",
  exp: 4_000_000_000,
};
const shell = {
  projects: [{ id: "project-shared", title: "Shared", workspaceRoot: "/workspace/shared" }],
  threads: [
    {
      id: "thread-shared",
      projectId: "project-shared",
      runtimeMode: "auto",
      archivedAt: null,
      worktreePath: null,
    },
  ],
  archivedThreads: [],
} as never;

it("allows only safe relative project paths", () => {
  expect(isSafeSharedProjectRelativePath(undefined)).toBe(true);
  expect(isSafeSharedProjectRelativePath("src/index.ts")).toBe(true);
  for (const path of [
    "/etc/passwd",
    "../private",
    "src/../private",
    "src/.git/config",
    "src\\private",
    "src\u0000file",
  ]) {
    expect(isSafeSharedProjectRelativePath(path)).toBe(false);
  }
});

it("allows scoped message dispatch but rejects attachments, full access, and foreign threads", () => {
  const base = {
    type: "message.dispatch",
    commandId: "command-1",
    threadId: "thread-shared",
    messageId: "message-1",
    text: "Update the project readme",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  };
  expect(isAllowedSharedProjectCommand(base, shell, grant)).toBe(true);
  expect(
    isAllowedSharedProjectCommand(
      { ...base, modelSelection: { instanceId: "provider", model: "chosen" } },
      shell,
      grant,
    ),
  ).toBe(true);
  expect(
    isAllowedSharedProjectCommand({ ...base, attachments: [{ id: "attachment" }] }, shell, grant),
  ).toBe(false);
  expect(isAllowedSharedProjectCommand({ ...base, runtimeMode: "full-access" }, shell, grant)).toBe(
    false,
  );
  expect(isAllowedSharedProjectCommand({ ...base, threadId: "thread-private" }, shell, grant)).toBe(
    false,
  );
  expect(
    isAllowedSharedProjectCommand(
      { ...base, type: "runtime-request.respond", requestId: "request-1", decision: "approve" },
      shell,
      grant,
    ),
  ).toBe(true);
  expect(
    isAllowedSharedProjectCommand(
      { ...base, type: "runtime-request.respond", requestId: "request-1" },
      shell,
      grant,
    ),
  ).toBe(false);
  expect(
    isAllowedSharedProjectCommand(
      {
        ...base,
        type: "runtime-request.respond",
        requestId: "request-1",
        decision: "approve",
        answers: {},
      },
      shell,
      grant,
    ),
  ).toBe(false);
  expect(
    isAllowedSharedProjectCommand(
      {
        ...base,
        type: "runtime-request.respond",
        requestId: "request-1",
        decision: "approve",
        attachmentsByQuestionId: {},
      },
      shell,
      grant,
    ),
  ).toBe(false);
  const create = {
    type: "thread.create",
    threadId: "thread-new",
    projectId: "project-shared",
    title: "New shared conversation",
    branch: null,
    worktreePath: null,
    runtimeMode: "auto",
  };
  expect(isAllowedSharedProjectCommand(create, shell, grant)).toBe(true);
  expect(
    isAllowedSharedProjectCommand({ ...create, threadId: "thread-shared" }, shell, grant),
  ).toBe(false);
  expect(
    isAllowedSharedProjectCommand({ ...create, projectId: "project-private" }, shell, grant),
  ).toBe(false);
});
