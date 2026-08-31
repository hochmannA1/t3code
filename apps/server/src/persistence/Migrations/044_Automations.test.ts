import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0044 from "./044_Automations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_Automations", (it) => {
  it.effect("accepts the automation schema created by the former migration 42", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* Migration0044;
      yield* sql`
        INSERT INTO automations (
          automation_id,
          project_id,
          name,
          prompt,
          schedule_json,
          destination_json,
          execution_json,
          status,
          revision,
          created_at,
          updated_at
        ) VALUES (
          'legacy-automation',
          'legacy-project',
          'Legacy automation',
          'Keep this row',
          '{}',
          '{}',
          '{}',
          'active',
          1,
          '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const automations = yield* sql<{ readonly automation_id: string }>`
        SELECT automation_id FROM automations
      `;
      const migrations = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 44
      `;

      assert.deepEqual([...automations], [{ automation_id: "legacy-automation" }]);
      assert.deepEqual([...migrations], [{ migration_id: 44 }]);
    }),
  );
});
