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
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import type { MemoryRecommendationGenerationInput } from "../textGeneration/MemoryRecommendationGeneration.ts";
import {
  make,
  MEMORY_RECOMMENDATION_WARM_CONCURRENCY,
  MEMORY_RECOMMENDATION_WARM_PROJECT_LIMIT,
} from "./MemoryService.ts";
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

const seedProjectActivity = (index: number, day: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stamp = `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, created_at, updated_at)
      VALUES (
        ${`recommendation-thread-${index}`},
        ${projectId(index)},
        ${`Thread ${index}`},
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

  it.effect("invalidates only scopes affected by the changed memory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-scope-cache-" });
      const calls: Array<string> = [];
      const generate = (input: MemoryRecommendationGenerationInput) =>
        Effect.sync(() => {
          const scope = input.project?.title ?? "personal";
          calls.push(scope);
          return recommendation(scope);
        });

      yield* openService(baseDir, generate, (service) =>
        Effect.gen(function* () {
          yield* seedProject(1);
          yield* seedProject(2);
          yield* service.upsert({
            projectId: null,
            title: "Personal",
            text: "Keep changes focused.",
            pinned: true,
          });
          yield* service.upsert({
            projectId: projectId(1),
            title: "First project",
            text: "First project detail.",
            pinned: true,
          });
          yield* service.upsert({
            projectId: projectId(2),
            title: "Second project",
            text: "Second project detail.",
            pinned: true,
          });

          const readAllScopes = () =>
            Effect.forEach(
              [null, projectId(1), projectId(2)] as const,
              (scope) => service.getRecommendations({ projectId: scope }),
              { concurrency: 1, discard: true },
            );
          yield* readAllScopes();
          assert.deepEqual(calls, ["personal", "Project 1", "Project 2"]);

          yield* service.upsert({
            projectId: projectId(2),
            title: "Second project changed",
            text: "Only this project changed.",
            pinned: true,
          });
          yield* readAllScopes();
          assert.deepEqual(calls, ["personal", "Project 1", "Project 2", "Project 2"]);

          yield* service.upsert({
            projectId: null,
            title: "Personal changed",
            text: "Every scope receives personal memory.",
            pinned: true,
          });
          yield* readAllScopes();
          assert.deepEqual(calls, [
            "personal",
            "Project 1",
            "Project 2",
            "Project 2",
            "personal",
            "Project 1",
            "Project 2",
          ]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "warms personal and recent project scopes without blocking startup or exceeding limits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-warmup-" });
        const firstWaveStarted = yield* Deferred.make<void>();
        const releaseFirstWave = yield* Deferred.make<void>();
        const warmupCompleted = yield* Deferred.make<void>();
        const generatedScopes: Array<string> = [];
        const expectedCalls = MEMORY_RECOMMENDATION_WARM_PROJECT_LIMIT + 1;
        let active = 0;
        let completed = 0;
        let maxActive = 0;
        const generate: RecommendationGenerator = (input: MemoryRecommendationGenerationInput) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active += 1;
              maxActive = Math.max(maxActive, active);
              generatedScopes.push(input.project?.title ?? "personal");
              return generatedScopes.length;
            }),
            (callNumber) =>
              Effect.gen(function* () {
                if (callNumber === MEMORY_RECOMMENDATION_WARM_CONCURRENCY) {
                  yield* Deferred.succeed(firstWaveStarted, undefined);
                }
                yield* Deferred.await(releaseFirstWave);
                return recommendation(input.project?.title ?? "personal");
              }),
            () =>
              Effect.sync(() => {
                active -= 1;
                completed += 1;
              }).pipe(
                Effect.flatMap(() =>
                  completed === expectedCalls
                    ? Deferred.succeed(warmupCompleted, undefined)
                    : Effect.void,
                ),
              ),
          );

        yield* openService(baseDir, generate, (service) =>
          Effect.gen(function* () {
            yield* service.upsert({
              projectId: null,
              title: "Personal",
              text: "Keep startup responsive.",
              pinned: true,
            });
            for (let index = 0; index < MEMORY_RECOMMENDATION_WARM_PROJECT_LIMIT + 2; index += 1) {
              yield* seedProject(index);
              yield* service.upsert({
                projectId: projectId(index),
                title: `Memory ${index}`,
                text: `Project ${index} memory.`,
                pinned: true,
              });
            }
            yield* seedProjectActivity(0, 20);
            yield* seedProjectActivity(1, 21);

            yield* forkParked(service.warmRecommendations());
            yield* Deferred.await(firstWaveStarted);
            assert.equal(generatedScopes.length, MEMORY_RECOMMENDATION_WARM_CONCURRENCY);
            assert.equal(maxActive, MEMORY_RECOMMENDATION_WARM_CONCURRENCY);
            yield* Deferred.succeed(releaseFirstWave, undefined);
            yield* Deferred.await(warmupCompleted);

            assert.equal(generatedScopes.length, expectedCalls);
            assert.equal(maxActive, MEMORY_RECOMMENDATION_WARM_CONCURRENCY);
            assert.includeMembers(generatedScopes, ["personal"]);
            assert.sameMembers(
              generatedScopes.filter((scope) => scope !== "personal"),
              ["Project 0", "Project 1", "Project 4", "Project 5", "Project 6", "Project 7"],
            );
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
