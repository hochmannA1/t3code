import {
  AutomationError,
  AutomationId,
  AutomationRemoteDispatchInput,
  AutomationRemoteDispatchResult,
  AutomationRun,
  AutomationRunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AutomationService } from "./AutomationService.ts";

const decodeDispatchInput = Schema.decodeUnknownEffect(AutomationRemoteDispatchInput);
const dispatchResponse = HttpServerResponse.schemaJson(AutomationRemoteDispatchResult);
const runResponse = HttpServerResponse.schemaJson(AutomationRun);
const isAutomationError = Schema.is(AutomationError);

export function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

const requireInternalToken = Effect.fn("automations.http.requireInternalToken")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const expected = process.env.T3_AUTOMATIONS_INTERNAL_TOKEN?.trim() ?? "";
  if (expected === "") {
    return HttpServerResponse.text("Automation dispatch is not configured.", {
      status: 503,
    });
  }
  const actual = request.headers["x-t3-automations-token"]?.trim() ?? "";
  if (!constantTimeTokenEqual(actual, expected)) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }
});

function automationErrorResponse(error: AutomationError) {
  const status =
    error.code === "not-found"
      ? 404
      : error.code === "conflict"
        ? 409
        : error.code === "persistence-failed" || error.code === "dispatch-failed"
          ? 500
          : 400;
  return HttpServerResponse.jsonUnsafe(
    { error: { code: error.code, message: error.message } },
    { status },
  );
}

const dispatchRoute = HttpRouter.add(
  "POST",
  "/api/internal/automations/:automationId/runs",
  Effect.gen(function* () {
    const authFailure = yield* requireInternalToken();
    if (authFailure !== undefined) return authFailure;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const automationId = AutomationId.make(params.automationId ?? "");
    const input = yield* request.json.pipe(Effect.flatMap(decodeDispatchInput), Effect.option);
    if (Option.isNone(input)) {
      return HttpServerResponse.text("Invalid automation run request.", { status: 400 });
    }
    const automations = yield* AutomationService;
    return yield* automations.dispatchRemote(automationId, input.value).pipe(
      Effect.flatMap((result) => dispatchResponse(result, { status: 202 })),
      Effect.catchIf(isAutomationError, (error) => Effect.succeed(automationErrorResponse(error))),
    );
  }),
);

const statusRoute = HttpRouter.add(
  "GET",
  "/api/internal/automations/:automationId/runs/:runId",
  Effect.gen(function* () {
    const authFailure = yield* requireInternalToken();
    if (authFailure !== undefined) return authFailure;
    const params = yield* HttpRouter.params;
    const automations = yield* AutomationService;
    return yield* automations
      .getRunStatus({
        automationId: AutomationId.make(params.automationId ?? ""),
        runId: AutomationRunId.make(params.runId ?? ""),
      })
      .pipe(
        Effect.flatMap((run) => runResponse(run)),
        Effect.catchIf(isAutomationError, (error) =>
          Effect.succeed(automationErrorResponse(error)),
        ),
      );
  }),
);

export const automationInternalRouteLayer = Layer.mergeAll(dispatchRoute, statusRoute);
