import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Automations from "./Migrations/Fork_001_Automations.ts";

describe("fork migration namespace", () => {
  it.effect("keeps a fresh upstream watermark independent from fork migrations", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toForkMigrationInclusive: 2 });
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        [
          ...(yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 42 ORDER BY migration_id`),
        ],
        [
          { migration_id: 42, name: "ProjectionThreadLinkedPullRequest" },
          { migration_id: 43, name: "ProjectionThreadsUnsettledAt" },
          { migration_id: 44, name: "ClearAutomaticProjectModelDefaults" },
          { migration_id: 45, name: "ProjectionProjectsAutoPull" },
          { migration_id: 46, name: "RepairAutomaticSettlementTimestamps" },
          { migration_id: 47, name: "ProjectionProjectIcon" },
        ],
      );
      assert.deepEqual(
        [
          ...(yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`),
        ],
        [
          { migration_id: 1, name: "Automations" },
          { migration_id: 2, name: "RepairRenumberedProjectionThreadColumns" },
        ],
      );
      assert.deepEqual(yield* runMigrations({ toForkMigrationInclusive: 2 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adopts released 44/45 history and lets current upstream through 47 run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* Automations;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
          (44, 'Automations', '2026-08-30 10:00:00'),
          (45, 'RepairRenumberedProjectionThreadColumns', '2026-08-31 10:00:00')
      `;
      yield* runMigrations({ toForkMigrationInclusive: 2 });
      assert.deepEqual(
        [
          ...(yield* sql`SELECT migration_id, created_at FROM effect_sql_fork_migrations ORDER BY migration_id`),
        ],
        [
          { migration_id: 1, created_at: "2026-08-30 10:00:00" },
          { migration_id: 2, created_at: "2026-08-31 10:00:00" },
        ],
      );
      const projectColumns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_projects)`;
      assert.includeMembers(
        projectColumns.map((column) => column.name),
        ["auto_pull", "project_icon_json"],
      );
      yield* runMigrations({ toForkMigrationInclusive: 2 });
      assert.deepEqual(
        [
          ...(yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 44 ORDER BY migration_id`),
        ],
        [
          { migration_id: 44, name: "ClearAutomaticProjectModelDefaults" },
          { migration_id: 45, name: "ProjectionProjectsAutoPull" },
          { migration_id: 46, name: "RepairAutomaticSettlementTimestamps" },
          { migration_id: 47, name: "ProjectionProjectIcon" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("repairs the earlier migration 42 collision below the upstream watermark", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Automations;
      yield* sql`ALTER TABLE projection_threads ADD COLUMN unsettled_at TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (42, 'Automations'),
          (43, 'ProjectionThreadsUnsettledAt'),
          (44, 'Automations')
      `;
      yield* runMigrations({ toForkMigrationInclusive: 2 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.include(
        columns.map((column) => column.name),
        "linked_pull_request_json",
      );
      assert.deepEqual(
        [...(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 42`)],
        [{ name: "ProjectionThreadLinkedPullRequest" }],
      );
      assert.deepEqual(
        [...(yield* sql`SELECT name FROM effect_sql_fork_migrations WHERE migration_id = 1`)],
        [{ name: "Automations" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rolls back adoption when an existing fork ledger conflicts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* Automations;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (44, 'Automations')`;
      yield* sql`INSERT INTO effect_sql_fork_migrations (migration_id, name) VALUES (1, 'UnrecognizedMigration')`;
      const failure = yield* Effect.flip(runMigrations({ toForkMigrationInclusive: 2 }));
      assert.equal(failure._tag, "MigrationError");
      assert.deepEqual(
        [...(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 44`)],
        [{ name: "Automations" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
