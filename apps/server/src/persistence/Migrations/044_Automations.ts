import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      execution_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
      next_run_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      paused_reason TEXT CHECK (
        paused_reason IS NULL OR paused_reason IN (
          'user',
          'three-consecutive-failures',
          'one-time-completed'
        )
      ),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX automations_project_updated_idx
    ON automations(project_id, updated_at DESC, automation_id)
  `;

  yield* sql`
    CREATE INDEX automations_due_idx
    ON automations(next_run_at, automation_id)
    WHERE status = 'active' AND next_run_at IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(automation_id) ON DELETE CASCADE,
      occurrence_key TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'waiting-for-thread', 'running', 'succeeded', 'failed')
      ),
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'remote')),
      thread_id TEXT,
      started_at TEXT,
      finished_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (automation_id, occurrence_key)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX automation_runs_one_active_idx
    ON automation_runs(automation_id)
    WHERE status IN ('pending', 'waiting-for-thread', 'running')
  `;

  yield* sql`
    CREATE INDEX automation_runs_history_idx
    ON automation_runs(automation_id, created_at DESC, run_id DESC)
  `;

  yield* sql`
    CREATE TABLE automation_mirror_outbox (
      automation_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
      payload_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX automation_mirror_outbox_due_idx
    ON automation_mirror_outbox(next_attempt_at, automation_id)
  `;
});
