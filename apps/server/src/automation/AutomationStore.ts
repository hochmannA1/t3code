import {
  AUTOMATION_RUN_HISTORY_LIMIT,
  Automation,
  AutomationDestination,
  AutomationError,
  AutomationExecution,
  AutomationId,
  AutomationMirrorRegistration,
  AutomationRun,
  AutomationSchedule,
  type AutomationRunId,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const ScheduleJson = Schema.fromJsonString(AutomationSchedule);
const DestinationJson = Schema.fromJsonString(AutomationDestination);
const ExecutionJson = Schema.fromJsonString(AutomationExecution);
const MirrorRegistrationJson = Schema.fromJsonString(AutomationMirrorRegistration);
const MirrorDeleteJson = Schema.fromJsonString(Schema.Struct({ revision: Schema.Number }));

const AutomationDbRow = Automation.mapFields(
  Struct.assign({
    schedule: ScheduleJson,
    destination: DestinationJson,
    execution: ExecutionJson,
  }),
);

export const AutomationMirrorOutboxEntry = Schema.Struct({
  automationId: AutomationId,
  revision: Schema.Number,
  operation: Schema.Literals(["put", "delete"]),
  payloadJson: Schema.NullOr(Schema.String),
  attemptCount: Schema.Number,
  nextAttemptAt: Schema.String,
});
export type AutomationMirrorOutboxEntry = typeof AutomationMirrorOutboxEntry.Type;

const decodeAutomation = Schema.decodeUnknownEffect(AutomationDbRow);
const decodeRun = Schema.decodeUnknownEffect(AutomationRun);
const decodeMirrorOutboxEntry = Schema.decodeUnknownEffect(AutomationMirrorOutboxEntry);
const encodeSchedule = Schema.encodeEffect(ScheduleJson);
const encodeDestination = Schema.encodeEffect(DestinationJson);
const encodeExecution = Schema.encodeEffect(ExecutionJson);
const encodeMirrorRegistration = Schema.encodeEffect(MirrorRegistrationJson);
const encodeMirrorDelete = Schema.encodeEffect(MirrorDeleteJson);

const persistenceError = (operation: string, cause: unknown) =>
  new AutomationError({
    code: "persistence-failed",
    message: `Automation storage failed during ${operation}.`,
    cause,
  });
const isAutomationError = Schema.is(AutomationError);

const mapStoreError = (operation: string) =>
  Effect.mapError((cause: unknown) =>
    isAutomationError(cause) ? cause : persistenceError(operation, cause),
  );

const selectAutomationSql = (sql: SqlClient.SqlClient, suffix: string) =>
  sql.unsafe<Record<string, unknown>>(
    `
  SELECT
    automation_id AS automationId,
    project_id AS projectId,
    name,
    prompt,
    schedule_json AS schedule,
    destination_json AS destination,
    execution_json AS execution,
    status,
    next_run_at AS nextRunAt,
    consecutive_failures AS consecutiveFailures,
    paused_reason AS pausedReason,
    revision,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM automations
  ${suffix}
`,
    [],
  );

const selectRunSql = (sql: SqlClient.SqlClient, suffix: string) =>
  sql.unsafe<Record<string, unknown>>(
    `
  SELECT
    run_id AS runId,
    automation_id AS automationId,
    occurrence_key AS occurrenceKey,
    scheduled_for AS scheduledFor,
    status,
    trigger,
    thread_id AS threadId,
    started_at AS startedAt,
    finished_at AS finishedAt,
    failure_reason AS failureReason,
    created_at AS createdAt
  FROM automation_runs
  ${suffix}
`,
    [],
  );

export interface InsertRunInput {
  readonly runId: AutomationRunId;
  readonly automationId: AutomationId;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly trigger: AutomationRunTrigger;
  readonly createdAt: string;
  readonly initialStatus?: AutomationRunStatus;
  readonly failureReason?: string;
}

export interface AutomationStoreShape {
  readonly list: (
    projectId?: ProjectId,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationError>;
  readonly get: (
    automationId: AutomationId,
  ) => Effect.Effect<Option.Option<Automation>, AutomationError>;
  readonly save: (automation: Automation) => Effect.Effect<void, AutomationError>;
  readonly saveOperationalState: (automation: Automation) => Effect.Effect<void, AutomationError>;
  readonly remove: (
    automationId: AutomationId,
    deletedAt: string,
  ) => Effect.Effect<void, AutomationError>;
  readonly listDue: (now: string) => Effect.Effect<ReadonlyArray<Automation>, AutomationError>;
  readonly insertRun: (
    input: InsertRunInput,
  ) => Effect.Effect<
    { readonly run: AutomationRun; readonly deduplicated: boolean },
    AutomationError
  >;
  readonly getRunByOccurrence: (
    automationId: AutomationId,
    occurrenceKey: string,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationError>;
  readonly getRun: (
    runId: AutomationRunId,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationError>;
  readonly listRuns: (
    automationId: AutomationId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationError>;
  readonly listRunnable: () => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationError>;
  readonly updateRun: (run: AutomationRun) => Effect.Effect<void, AutomationError>;
  readonly finishRun: (
    run: AutomationRun,
    automation: Automation,
  ) => Effect.Effect<void, AutomationError>;
  readonly listMirrorOutboxDue: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<AutomationMirrorOutboxEntry>, AutomationError>;
  readonly completeMirrorOutbox: (
    automationId: AutomationId,
    revision: number,
  ) => Effect.Effect<void, AutomationError>;
  readonly retryMirrorOutbox: (
    automationId: AutomationId,
    revision: number,
    nextAttemptAt: string,
    lastError: string,
  ) => Effect.Effect<void, AutomationError>;
}

export class AutomationStore extends Context.Service<AutomationStore, AutomationStoreShape>()(
  "t3/automation/AutomationStore",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const get = Effect.fn("AutomationStore.get")(function* (automationId: AutomationId) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        automation_id AS automationId,
        project_id AS projectId,
        name,
        prompt,
        schedule_json AS schedule,
        destination_json AS destination,
        execution_json AS execution,
        status,
        next_run_at AS nextRunAt,
        consecutive_failures AS consecutiveFailures,
        paused_reason AS pausedReason,
        revision,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM automations
      WHERE automation_id = ${automationId}
    `;
    const row = rows[0];
    return row === undefined ? Option.none() : Option.some(yield* decodeAutomation(row));
  }, mapStoreError("get"));

  const list = Effect.fn("AutomationStore.list")(function* (projectId?: ProjectId) {
    const rows =
      projectId === undefined
        ? yield* selectAutomationSql(sql, "ORDER BY updated_at DESC, automation_id ASC")
        : yield* sql<Record<string, unknown>>`
            SELECT
              automation_id AS automationId,
              project_id AS projectId,
              name,
              prompt,
              schedule_json AS schedule,
              destination_json AS destination,
              execution_json AS execution,
              status,
              next_run_at AS nextRunAt,
              consecutive_failures AS consecutiveFailures,
              paused_reason AS pausedReason,
              revision,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM automations
            WHERE project_id = ${projectId}
            ORDER BY updated_at DESC, automation_id ASC
          `;
    return yield* Effect.forEach(rows, (row) => decodeAutomation(row));
  }, mapStoreError("list"));

  const writeAutomation = Effect.fn("AutomationStore.writeAutomation")(function* (
    automation: Automation,
  ) {
    const scheduleJson = yield* encodeSchedule(automation.schedule);
    const destinationJson = yield* encodeDestination(automation.destination);
    const executionJson = yield* encodeExecution(automation.execution);
    yield* sql`
      INSERT INTO automations (
        automation_id, project_id, name, prompt, schedule_json, destination_json,
        execution_json, status, next_run_at, consecutive_failures, paused_reason,
        revision, created_at, updated_at
      ) VALUES (
        ${automation.automationId}, ${automation.projectId}, ${automation.name}, ${automation.prompt},
        ${scheduleJson}, ${destinationJson}, ${executionJson}, ${automation.status},
        ${automation.nextRunAt}, ${automation.consecutiveFailures}, ${automation.pausedReason},
        ${automation.revision}, ${automation.createdAt}, ${automation.updatedAt}
      )
      ON CONFLICT (automation_id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        prompt = excluded.prompt,
        schedule_json = excluded.schedule_json,
        destination_json = excluded.destination_json,
        execution_json = excluded.execution_json,
        status = excluded.status,
        next_run_at = excluded.next_run_at,
        consecutive_failures = excluded.consecutive_failures,
        paused_reason = excluded.paused_reason,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `;
  });

  const enqueueMirrorPut = Effect.fn("AutomationStore.enqueueMirrorPut")(function* (
    automation: Automation,
  ) {
    const registration: AutomationMirrorRegistration = {
      automationId: automation.automationId,
      projectId: automation.projectId,
      revision: automation.revision,
      enabled: automation.status === "active",
      schedule: automation.schedule,
      nextRunAt: automation.nextRunAt,
    };
    const payloadJson = yield* encodeMirrorRegistration(registration);
    yield* sql`
      INSERT INTO automation_mirror_outbox (
        automation_id, revision, operation, payload_json, attempt_count,
        next_attempt_at, last_error, created_at, updated_at
      ) VALUES (
        ${automation.automationId}, ${automation.revision}, 'put', ${payloadJson},
        0, ${automation.updatedAt}, NULL, ${automation.updatedAt}, ${automation.updatedAt}
      )
      ON CONFLICT (automation_id) DO UPDATE SET
        revision = excluded.revision,
        operation = excluded.operation,
        payload_json = excluded.payload_json,
        attempt_count = 0,
        next_attempt_at = excluded.next_attempt_at,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE excluded.revision >= automation_mirror_outbox.revision
    `;
  });

  const save = Effect.fn("AutomationStore.save")(function* (automation: Automation) {
    yield* sql.withTransaction(
      Effect.all([writeAutomation(automation), enqueueMirrorPut(automation)]),
    );
  }, mapStoreError("save"));

  const saveOperationalState = Effect.fn("AutomationStore.saveOperationalState")(function* (
    automation: Automation,
  ) {
    yield* sql.withTransaction(
      Effect.all([writeAutomation(automation), enqueueMirrorPut(automation)]),
    );
  }, mapStoreError("save operational state"));

  const remove = Effect.fn("AutomationStore.remove")(function* (
    automationId: AutomationId,
    deletedAt: string,
  ) {
    const existing = yield* get(automationId);
    if (Option.isNone(existing)) {
      return yield* new AutomationError({
        code: "not-found",
        message: "Automation not found.",
      });
    }
    const revision = existing.value.revision + 1;
    const payloadJson = yield* encodeMirrorDelete({ revision });
    yield* sql.withTransaction(
      Effect.all([
        sql`DELETE FROM automations WHERE automation_id = ${automationId}`,
        sql`
          INSERT INTO automation_mirror_outbox (
            automation_id, revision, operation, payload_json, attempt_count,
            next_attempt_at, last_error, created_at, updated_at
          ) VALUES (
            ${automationId}, ${revision}, 'delete', ${payloadJson},
            0, ${deletedAt}, NULL, ${deletedAt}, ${deletedAt}
          )
          ON CONFLICT (automation_id) DO UPDATE SET
            revision = excluded.revision,
            operation = excluded.operation,
            payload_json = excluded.payload_json,
            attempt_count = 0,
            next_attempt_at = excluded.next_attempt_at,
            last_error = NULL,
            updated_at = excluded.updated_at
          WHERE excluded.revision >= automation_mirror_outbox.revision
        `,
      ]),
    );
  }, mapStoreError("remove"));

  const listDue = Effect.fn("AutomationStore.listDue")(function* (now: string) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        automation_id AS automationId,
        project_id AS projectId,
        name,
        prompt,
        schedule_json AS schedule,
        destination_json AS destination,
        execution_json AS execution,
        status,
        next_run_at AS nextRunAt,
        consecutive_failures AS consecutiveFailures,
        paused_reason AS pausedReason,
        revision,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM automations
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ${now}
      ORDER BY next_run_at ASC, automation_id ASC
    `;
    return yield* Effect.forEach(rows, (row) => decodeAutomation(row));
  }, mapStoreError("list due"));

  const getRunByOccurrence = Effect.fn("AutomationStore.getRunByOccurrence")(function* (
    automationId: AutomationId,
    occurrenceKey: string,
  ) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        run_id AS runId, automation_id AS automationId, occurrence_key AS occurrenceKey,
        scheduled_for AS scheduledFor, status, trigger, thread_id AS threadId,
        started_at AS startedAt, finished_at AS finishedAt, failure_reason AS failureReason,
        created_at AS createdAt
      FROM automation_runs
      WHERE automation_id = ${automationId} AND occurrence_key = ${occurrenceKey}
    `;
    return rows[0] === undefined ? Option.none() : Option.some(yield* decodeRun(rows[0]));
  }, mapStoreError("get run by occurrence"));

  const insertRun = Effect.fn("AutomationStore.insertRun")(function* (input: InsertRunInput) {
    const existing = yield* getRunByOccurrence(input.automationId, input.occurrenceKey);
    if (Option.isSome(existing)) return { run: existing.value, deduplicated: true };

    yield* sql`
      INSERT OR IGNORE INTO automation_runs (
        run_id, automation_id, occurrence_key, scheduled_for, status, trigger,
        thread_id, started_at, finished_at, failure_reason, created_at
      ) VALUES (
        ${input.runId}, ${input.automationId}, ${input.occurrenceKey}, ${input.scheduledFor},
        ${input.initialStatus ?? "pending"}, ${input.trigger}, NULL, NULL,
        ${input.initialStatus === "failed" ? input.createdAt : null},
        ${input.failureReason ?? null}, ${input.createdAt}
      )
    `;
    const inserted = yield* getRunByOccurrence(input.automationId, input.occurrenceKey);
    if (Option.isNone(inserted)) {
      return yield* new AutomationError({
        code: "conflict",
        message: "This automation already has an active run.",
      });
    }
    yield* sql`
      DELETE FROM automation_runs
      WHERE automation_id = ${input.automationId}
        AND run_id NOT IN (
          SELECT run_id FROM automation_runs
          WHERE automation_id = ${input.automationId}
          ORDER BY created_at DESC, run_id DESC
          LIMIT ${AUTOMATION_RUN_HISTORY_LIMIT}
        )
        AND status IN ('succeeded', 'failed')
    `;
    return { run: inserted.value, deduplicated: false };
  }, mapStoreError("insert run"));

  const getRun = Effect.fn("AutomationStore.getRun")(function* (runId: AutomationRunId) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        run_id AS runId, automation_id AS automationId, occurrence_key AS occurrenceKey,
        scheduled_for AS scheduledFor, status, trigger, thread_id AS threadId,
        started_at AS startedAt, finished_at AS finishedAt, failure_reason AS failureReason,
        created_at AS createdAt
      FROM automation_runs WHERE run_id = ${runId}
    `;
    return rows[0] === undefined ? Option.none() : Option.some(yield* decodeRun(rows[0]));
  }, mapStoreError("get run"));

  const listRuns = Effect.fn("AutomationStore.listRuns")(function* (
    automationId: AutomationId,
    limit: number,
  ) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT
        run_id AS runId, automation_id AS automationId, occurrence_key AS occurrenceKey,
        scheduled_for AS scheduledFor, status, trigger, thread_id AS threadId,
        started_at AS startedAt, finished_at AS finishedAt, failure_reason AS failureReason,
        created_at AS createdAt
      FROM automation_runs
      WHERE automation_id = ${automationId}
      ORDER BY created_at DESC, run_id DESC
      LIMIT ${Math.min(limit, AUTOMATION_RUN_HISTORY_LIMIT)}
    `;
    return yield* Effect.forEach(rows, (row) => decodeRun(row));
  }, mapStoreError("list runs"));

  const listRunnable = Effect.fn("AutomationStore.listRunnable")(function* () {
    const rows = yield* selectRunSql(
      sql,
      "WHERE status IN ('pending', 'waiting-for-thread', 'running') ORDER BY created_at ASC, run_id ASC",
    );
    return yield* Effect.forEach(rows, (row) => decodeRun(row));
  }, mapStoreError("list runnable"));

  const updateRun = Effect.fn("AutomationStore.updateRun")(function* (run: AutomationRun) {
    yield* sql`
      UPDATE automation_runs SET
        status = ${run.status}, thread_id = ${run.threadId}, started_at = ${run.startedAt},
        finished_at = ${run.finishedAt}, failure_reason = ${run.failureReason}
      WHERE run_id = ${run.runId}
    `;
  }, mapStoreError("update run"));

  const finishRun = Effect.fn("AutomationStore.finishRun")(function* (
    run: AutomationRun,
    automation: Automation,
  ) {
    yield* sql.withTransaction(
      Effect.all([
        sql`
          UPDATE automation_runs SET
            status = ${run.status}, thread_id = ${run.threadId}, started_at = ${run.startedAt},
            finished_at = ${run.finishedAt}, failure_reason = ${run.failureReason}
          WHERE run_id = ${run.runId}
        `,
        writeAutomation(automation),
        enqueueMirrorPut(automation),
      ]),
    );
  }, mapStoreError("finish run"));

  const listMirrorOutboxDue = Effect.fn("AutomationStore.listMirrorOutboxDue")(function* (
    now: string,
  ) {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT automation_id AS automationId, revision, operation, payload_json AS payloadJson,
        attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt
      FROM automation_mirror_outbox
      WHERE next_attempt_at <= ${now}
      ORDER BY next_attempt_at ASC, automation_id ASC
      LIMIT 100
    `;
    return yield* Effect.forEach(rows, (row) => decodeMirrorOutboxEntry(row));
  }, mapStoreError("list mirror outbox"));

  const completeMirrorOutbox = Effect.fn("AutomationStore.completeMirrorOutbox")(function* (
    automationId: AutomationId,
    revision: number,
  ) {
    yield* sql`
      DELETE FROM automation_mirror_outbox
      WHERE automation_id = ${automationId} AND revision = ${revision}
    `;
  }, mapStoreError("complete mirror outbox"));

  const retryMirrorOutbox = Effect.fn("AutomationStore.retryMirrorOutbox")(function* (
    automationId: AutomationId,
    revision: number,
    nextAttemptAt: string,
    lastError: string,
  ) {
    yield* sql`
      UPDATE automation_mirror_outbox SET
        attempt_count = attempt_count + 1,
        next_attempt_at = ${nextAttemptAt},
        last_error = ${lastError.slice(0, 4_000)}
      WHERE automation_id = ${automationId} AND revision = ${revision}
    `;
  }, mapStoreError("retry mirror outbox"));

  return AutomationStore.of({
    list,
    get,
    save,
    saveOperationalState,
    remove,
    listDue,
    insertRun,
    getRunByOccurrence,
    getRun,
    listRuns,
    listRunnable,
    updateRun,
    finishRun,
    listMirrorOutboxDue,
    completeMirrorOutbox,
    retryMirrorOutbox,
  });
});

export const layer = Layer.effect(AutomationStore, make);
