import {
  AutomationId,
  AutomationRunId,
  ProjectId,
  ProviderInstanceId,
  type Automation,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore, layer as AutomationStoreLayer } from "./AutomationStore.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    AutomationStoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const makeAutomation = (overrides: Partial<Automation> = {}): Automation => ({
  automationId: AutomationId.make("automation-store-test"),
  projectId: ProjectId.make("project-store-test"),
  name: "Daily report",
  prompt: "Prepare the daily report.",
  schedule: { kind: "interval", everyMinutes: 60, startsAt: "2026-08-23T10:00:00.000Z" },
  destination: { kind: "new-thread" },
  execution: {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    approvalPolicy: "never",
    interactionMode: "default",
    responseProfile: "work",
    branch: null,
    worktreePath: null,
  },
  status: "active",
  nextRunAt: "2026-08-23T10:00:00.000Z",
  consecutiveFailures: 0,
  pausedReason: null,
  revision: 1,
  createdAt: "2026-08-23T09:00:00.000Z",
  updatedAt: "2026-08-23T09:00:00.000Z",
  ...overrides,
});

testLayer("AutomationStore", (it) => {
  it.effect("persists definitions and mirrors schedule data without the prompt", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const automation = makeAutomation();

      yield* store.save(automation);
      const persisted = yield* store.get(automation.automationId);
      assert.deepStrictEqual(Option.getOrThrow(persisted), automation);

      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM automation_mirror_outbox
        WHERE automation_id = ${automation.automationId}
      `;
      assert.strictEqual(rows.length, 1);
      assert.notInclude(rows[0]?.payload ?? "", automation.prompt);
      assert.include(rows[0]?.payload ?? "", '"name":"Daily report"');
      assert.include(rows[0]?.payload ?? "", '"nextRunAt":"2026-08-23T10:00:00.000Z"');
    }),
  );

  it.effect("deduplicates occurrences and permits only one active run", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const automation = makeAutomation({ automationId: AutomationId.make("run-invariants") });
      yield* store.save(automation);

      const first = yield* store.insertRun({
        runId: AutomationRunId.make("run-one"),
        automationId: automation.automationId,
        occurrenceKey: "scheduled:2026-08-23T10:00:00.000Z",
        scheduledFor: "2026-08-23T10:00:00.000Z",
        trigger: "schedule",
        createdAt: "2026-08-23T10:00:00.000Z",
      });
      assert.isFalse(first.deduplicated);

      const duplicate = yield* store.insertRun({
        runId: AutomationRunId.make("run-duplicate"),
        automationId: automation.automationId,
        occurrenceKey: "scheduled:2026-08-23T10:00:00.000Z",
        scheduledFor: "2026-08-23T10:00:00.000Z",
        trigger: "remote",
        createdAt: "2026-08-23T10:00:01.000Z",
      });
      assert.isTrue(duplicate.deduplicated);
      assert.strictEqual(duplicate.run.runId, first.run.runId);

      const conflict = yield* Effect.flip(
        store.insertRun({
          runId: AutomationRunId.make("run-two"),
          automationId: automation.automationId,
          occurrenceKey: "scheduled:2026-08-23T11:00:00.000Z",
          scheduledFor: "2026-08-23T11:00:00.000Z",
          trigger: "schedule",
          createdAt: "2026-08-23T11:00:00.000Z",
        }),
      );
      assert.strictEqual(conflict.code, "conflict");
    }),
  );

  it.effect("writes a monotonic delete tombstone for the coordinator", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const sql = yield* SqlClient.SqlClient;
      const automation = makeAutomation({
        automationId: AutomationId.make("delete-tombstone"),
        revision: 7,
      });
      yield* store.save(automation);
      yield* store.remove(automation.automationId, "2026-08-23T12:00:00.000Z");

      const rows = yield* sql<{
        readonly operation: string;
        readonly revision: number;
        readonly payload: string;
      }>`
        SELECT operation, revision, payload_json AS payload
        FROM automation_mirror_outbox WHERE automation_id = ${automation.automationId}
      `;
      assert.deepStrictEqual(rows, [
        { operation: "delete", revision: 8, payload: '{"revision":8}' },
      ]);
      assert.isTrue(Option.isNone(yield* store.get(automation.automationId)));
    }),
  );

  it.effect("retains only the latest 100 completed runs", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const automation = makeAutomation({ automationId: AutomationId.make("history-limit") });
      yield* store.save(automation);

      for (let index = 0; index < 105; index += 1) {
        const minute = String(index).padStart(3, "0");
        yield* store.insertRun({
          runId: AutomationRunId.make(`history-run-${minute}`),
          automationId: automation.automationId,
          occurrenceKey: `history-${minute}`,
          scheduledFor: "2026-08-23T10:00:00.000Z",
          trigger: "schedule",
          createdAt: "2026-08-23T10:00:00.000Z",
          initialStatus: "failed",
          failureReason: "test failure",
        });
      }

      const rows = yield* store.listRuns(automation.automationId, 100);
      assert.strictEqual(rows.length, 100);
      assert.strictEqual(rows.at(-1)?.runId, AutomationRunId.make("history-run-005"));
    }),
  );
});
