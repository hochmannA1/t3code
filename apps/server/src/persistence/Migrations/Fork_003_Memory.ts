import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t3_memory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      manifest_json TEXT,
      lease_owner TEXT,
      lease_until TEXT
    )
  `;
  yield* sql`INSERT OR IGNORE INTO t3_memory_state (id) VALUES (1)`;
});
