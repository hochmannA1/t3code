import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "./ProjectService.ts";
import * as StandaloneProject from "./StandaloneProject.ts";

it.effect("allocates unique standalone project folders and registers them", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-standalone-project-" });
    const registrations: Array<{ readonly title: string; readonly workspaceRoot: string }> = [];
    const configLayer = Layer.effect(
      ServerConfig.ServerConfig,
      ServerConfig.ServerConfig.pipe(
        Effect.map((config) => ServerConfig.make({ ...config, standaloneProjectsDir: baseDir })),
      ),
    ).pipe(Layer.provide(ServerConfig.layerTest(baseDir, baseDir)));
    const projectLayer = Layer.mock(ProjectService.ProjectService)({
      create: (input) =>
        Effect.sync(() => {
          registrations.push({ title: input.title, workspaceRoot: input.workspaceRoot });
        }).pipe(Effect.as({} as never)),
    });
    const standaloneLayer = StandaloneProject.layer.pipe(
      Layer.provide(
        Layer.mergeAll(configLayer, projectLayer).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    const results = yield* Effect.gen(function* () {
      const service = yield* StandaloneProject.StandaloneProject;
      const first = yield* service.create({ request: "Build a Project" });
      const second = yield* service.create({ request: "Build a Project" });
      return [first, second] as const;
    }).pipe(Effect.provide(standaloneLayer));

    assert.equal(results[0].title, "build-a-project");
    assert.equal(results[1].title, "build-a-project-2");
    assert.equal(path.dirname(results[0].workspaceRoot), path.dirname(results[1].workspaceRoot));
    assert.isTrue(yield* fileSystem.exists(results[0].workspaceRoot));
    assert.isTrue(yield* fileSystem.exists(results[1].workspaceRoot));
    assert.deepEqual(
      registrations,
      results.map(({ title, workspaceRoot }) => ({ title, workspaceRoot })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("normalizes standalone project names without producing empty slugs", () => {
  assert.equal(StandaloneProject.standaloneProjectSlug("  Crème brûlée!  "), "creme-brulee");
  assert.equal(StandaloneProject.standaloneProjectSlug("!!!"), "new-task");
});
