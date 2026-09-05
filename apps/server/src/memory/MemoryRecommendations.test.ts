import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type MemoryGetRecommendationsResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { forkParked, ServerActivation } from "../serverActivation.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { MemoryRecommendationGenerationInput } from "../textGeneration/MemoryRecommendationGeneration.ts";
import { make } from "./MemoryService.ts";
import * as Sources from "./MemorySourceReader.ts";
import * as Store from "./MemoryStore.ts";

type RecommendationGenerator = TextGeneration["Service"]["generateMemoryRecommendations"];

const projectId = (index: number) => ProjectId.make(`recommendation-project-${index}`);
const recommendation = (label: string): MemoryGetRecommendationsResult => ({
  recommendations: [
    {
      id: `recommendation-${label.toLowerCase().replaceAll(" ", "-")}`,
      type: "task",
      label,
      prompt: `Start ${label}.`,
    },
  ],
  retryable: false,
});

const generationWith = (generateMemoryRecommendations: RecommendationGenerator) =>
  TextGeneration.of({
    generateMemory: () => Effect.die("Unexpected memory generation"),
    generateMemoryRecommendations,
    generateCommitMessage: () => Effect.die("Unexpected commit generation"),
    generatePrContent: () => Effect.die("Unexpected PR generation"),
    generateBranchName: () => Effect.die("Unexpected branch generation"),
    generateThreadTitle: () => Effect.die("Unexpected title generation"),
  });

function openService<A, E>(
  baseDir: string,
  generateMemoryRecommendations: RecommendationGenerator,
  body: (
    service: Effect.Success<typeof make>,
    store: Effect.Success<typeof Store.make>,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Path.Path | Scope.Scope>,
  observeManifestRead?: () => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    yield* runMigrations();
    const store = yield* Store.make;
    const sourceReader = yield* Sources.make;
    const observedStore = observeManifestRead
      ? Store.MemoryStore.of({
          ...store,
          read: () => store.read().pipe(Effect.tap(observeManifestRead)),
        })
      : store;
    const service = yield* make.pipe(
      Effect.provideService(Store.MemoryStore, observedStore),
      Effect.provideService(Sources.MemorySourceReader, sourceReader),
      Effect.provideService(TextGeneration, generationWith(generateMemoryRecommendations)),
    );
    return yield* body(service, store);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: `${baseDir}/state.sqlite` }),
        ServerConfig.layerTest(process.cwd(), baseDir),
        ServerSettings.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
}

const seedProject = (index: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stamp = `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (
        ${projectId(index)},
        ${`Project ${index}`},
        ${`/workspace/${index}`},
        '[]',
        ${stamp},
        ${stamp}
      )`;
  });

describe("memory recommendation caching and warmup", () => {
  it.effect("reuses a persisted recommendation after the service and database reopen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-recommendation-" });
      let calls = 0;
      const generate: RecommendationGenerator = () =>
        Effect.sync(() => {
          calls += 1;
          return recommendation("Resume deployment");
        });

      const firstRun = yield* openService(baseDir, generate, (service, store) =>
        Effect.gen(function* () {
          yield* service.upsert({
            projectId: null,
            title: "Deployment",
            text: "Resume the deployment review.",
            pinned: true,
          });
          const result = yield* service.getRecommendations({ projectId: null });
          const [entry] = (yield* store.read()).entries;
          if (!entry) return yield* Effect.die("Expected persisted memory metadata");
          return { result, notePath: `${store.directory}/notes/${entry.file}` };
        }),
      );
      yield* fs.remove(firstRun.notePath);
      const reopened = yield* openService(baseDir, generate, (service) =>
        service.getRecommendations({ projectId: null }),
      );

      assert.deepEqual(reopened, firstRun.result);
      assert.equal(calls, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("single-flights concurrent cache misses for the same freshness key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-single-flight-" });
      const generationStarted = yield* Deferred.make<void>();
      const releaseGeneration = yield* Deferred.make<void>();
      const secondRequestEntered = yield* Deferred.make<void>();
      let calls = 0;
      let lookups = 0;
      const generate: RecommendationGenerator = () =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.succeed(generationStarted, undefined);
          yield* Deferred.await(releaseGeneration);
          return recommendation("Inspect project");
        });

      yield* openService(
        baseDir,
        generate,
        (service) =>
          Effect.gen(function* () {
            yield* seedProject(1);
            yield* service.upsert({
              projectId: projectId(1),
              title: "Project memory",
              text: "Inspect this project.",
              pinned: true,
            });
            lookups = 0;
            const first = yield* service
              .getRecommendations({ projectId: projectId(1) })
              .pipe(Effect.forkChild);
            yield* Deferred.await(generationStarted);
            const second = yield* service
              .getRecommendations({ projectId: projectId(1) })
              .pipe(Effect.forkChild);
            yield* Deferred.await(secondRequestEntered);
            yield* Effect.yieldNow;
            assert.equal(calls, 1);
            yield* Deferred.succeed(releaseGeneration, undefined);
            assert.deepEqual(yield* Fiber.join(second), yield* Fiber.join(first));
            assert.equal(calls, 1);
          }),
        () =>
          Effect.sync(() => {
            lookups += 1;
          }).pipe(
            Effect.flatMap(() =>
              lookups === 2 ? Deferred.succeed(secondRequestEntered, undefined) : Effect.void,
            ),
          ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "parks warmup before readiness and shares its running generation with the first draft",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-startup-" });
        const activation = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        yield* openService(
          baseDir,
          () =>
            Effect.gen(function* () {
              calls += 1;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return recommendation("Prepared during startup");
            }),
          (service) =>
            Effect.gen(function* () {
              yield* service.upsert({
                projectId: null,
                title: "Next action",
                text: "Prepare next action.",
                pinned: true,
              });
              yield* forkParked(service.warmRecommendations()).pipe(
                Effect.provideService(ServerActivation, Deferred.await(activation)),
              );
              assert.equal(calls, 0);
              yield* Deferred.succeed(activation, undefined);
              yield* Deferred.await(started);
              // Model generation is still blocked, but readiness returned and other service work runs.
              assert.equal((yield* service.getState({})).entries.length, 1);
              const draft = yield* service
                .getRecommendations({ projectId: null })
                .pipe(Effect.forkChild);
              yield* Deferred.succeed(release, undefined);
              assert.equal(
                (yield* Fiber.join(draft)).recommendations[0]?.label,
                "Prepared during startup",
              );
              assert.equal(calls, 1);
            }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops background recommendation generation when the service scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-shutdown-" });
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      yield* openService(
        baseDir,
        () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
        (service) =>
          Effect.gen(function* () {
            yield* service.upsert({
              projectId: null,
              title: "Next action",
              text: "Prepare next action.",
              pinned: true,
            });
            yield* service.warmRecommendations().pipe(Effect.forkChild);
            yield* Deferred.await(started);
          }),
      ).pipe(Effect.scoped);
      assert.isTrue(yield* Deferred.isDone(stopped));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares global recommendations and invalidates them when any project changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-global-" });
      const inputs: Array<MemoryRecommendationGenerationInput> = [];
      yield* openService(
        baseDir,
        (input) =>
          Effect.sync(() => {
            inputs.push(input);
            return recommendation("Global next action");
          }),
        (service) =>
          Effect.gen(function* () {
            yield* seedProject(1);
            yield* seedProject(2);
            for (const index of [1, 2]) {
              yield* service.upsert({
                projectId: projectId(index),
                title: `Project ${index}`,
                text: `Continue project ${index}.`,
                pinned: true,
              });
            }
            const global = yield* service.getRecommendations({ projectId: null });
            assert.equal(global.recommendations.length, 1);
            assert.equal(inputs.length, 1);
            assert.sameMembers(
              inputs[0]!.memories.map((memory) => memory.projectId),
              [projectId(1), projectId(2)],
            );
            assert.equal(inputs[0]!.projects?.length, 2);
            assert.deepEqual(
              yield* service.getRecommendations({ projectId: projectId(1) }),
              global,
            );
            yield* service.warmRecommendations();
            assert.equal(inputs.length, 1);
            yield* service.upsert({
              projectId: projectId(2),
              title: "Changed",
              text: "New next action.",
              pinned: true,
            });
            yield* service.getRecommendations({ projectId: null });
            assert.equal(inputs.length, 2);
            yield* service.getRecommendations({ projectId: projectId(2) });
            assert.equal(inputs.length, 2);
          }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not reuse project evidence after its project is deleted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-deleted-project-" });
      let calls = 0;
      yield* openService(
        baseDir,
        () =>
          Effect.sync(() => {
            calls += 1;
            return recommendation("Continue project");
          }),
        (service) =>
          Effect.gen(function* () {
            yield* seedProject(1);
            yield* service.upsert({
              projectId: projectId(1),
              title: "Next action",
              text: "Continue work.",
              pinned: true,
            });
            yield* service.getRecommendations({ projectId: null });
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_projects SET deleted_at = '2026-09-05T00:00:00.000Z' WHERE project_id = ${projectId(1)}`;
            const result = yield* service.getRecommendations({ projectId: null });
            assert.deepEqual(result.recommendations, []);
            assert.equal(result.reason, "no-memories");
            assert.equal(calls, 1);
          }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
