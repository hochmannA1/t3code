import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  OrchestrationDispatchCommandError,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { createStandaloneProject, standaloneProjectSlug } from "./StandaloneProject.ts";

type ProjectCreateCommand = Extract<ClientOrchestrationCommand, { type: "project.create" }>;

describe("StandaloneProject", () => {
  it("derives a short filesystem-safe slug from the request", () => {
    assert.strictEqual(
      standaloneProjectSlug("  Prüfe die MAẞNAHMEN & create a report!  "),
      "prufe-die-massnahmen-create-a-report",
    );
    assert.strictEqual(standaloneProjectSlug("🧠✨"), "new-task");
    assert.isAtMost(standaloneProjectSlug("word ".repeat(100)).length, 64);
  });

  it.effect("reserves collision-free project directories and dispatches project.create", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-23T07:00:00.000Z"));
      const fileSystem = yield* FileSystem.FileSystem;
      const projectsRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-standalone-projects-",
      });
      const commands = yield* Ref.make<ReadonlyArray<ProjectCreateCommand>>([]);
      const dispatch = (command: ProjectCreateCommand) =>
        Ref.updateAndGet(commands, (current) => [...current, command]).pipe(
          Effect.map((current) => ({ sequence: current.length })),
        );

      const results = yield* Effect.all(
        [
          createStandaloneProject({
            request: "Prepare quarterly report",
            projectsRoot,
            dispatch,
          }),
          createStandaloneProject({
            request: "Prepare quarterly report",
            projectsRoot,
            dispatch,
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(results.map((result) => result.title).sort(), [
        "prepare-quarterly-report",
        "prepare-quarterly-report-2",
      ]);
      for (const result of results) {
        const stat = yield* fileSystem.stat(result.workspaceRoot);
        assert.strictEqual(stat.type, "Directory");
        assert.include(result.workspaceRoot, "/2026-08-23/");
      }

      const dispatched = yield* Ref.get(commands);
      assert.lengthOf(dispatched, 2);
      for (const command of dispatched) {
        assert.strictEqual(command.type, "project.create");
        assert.strictEqual(command.defaultModelSelection, null);
        assert.strictEqual(command.createdAt, "2026-08-23T07:00:00.000Z");
        assert.strictEqual(command.title, command.workspaceRoot.split("/").at(-1));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes its reserved directory when project registration fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-23T07:00:00.000Z"));
      const fileSystem = yield* FileSystem.FileSystem;
      const projectsRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-standalone-projects-failure-",
      });
      const expectedWorkspaceRoot = `${projectsRoot}/2026-08-23/write-brief`;

      const error = yield* createStandaloneProject({
        request: "Write brief",
        projectsRoot,
        dispatch: () =>
          Effect.fail(
            new OrchestrationDispatchCommandError({ message: "Project registration failed." }),
          ),
      }).pipe(Effect.flip);

      assert.strictEqual(error.message, "Project registration failed.");
      assert.isFalse(yield* fileSystem.exists(expectedWorkspaceRoot));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
