// @effect-diagnostics globalDate:off -- Retry timestamps are persisted as ISO strings.
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { AutomationStore, type AutomationMirrorOutboxEntry } from "./AutomationStore.ts";
import type { AutomationError } from "@t3tools/contracts";

const MAX_RETRY_DELAY_MS = 5 * 60_000;

const CoordinatorConfig = Config.all({
  baseUrl: Config.string("T3_AUTOMATIONS_COORDINATOR_URL").pipe(Config.option),
  token: Config.string("T3_AUTOMATIONS_COORDINATOR_TOKEN").pipe(Config.option),
});

export function automationMirrorUrl(baseUrl: string, automationId: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/automations/${encodeURIComponent(automationId)}`;
}

export function automationMirrorRetryAt(attemptedAt: string, previousAttemptCount: number): string {
  const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.min(previousAttemptCount, 12));
  return new Date(Date.parse(attemptedAt) + delay).toISOString();
}

export interface AutomationMirrorShape {
  readonly flush: (at?: string) => Effect.Effect<void, AutomationError>;
}

export class AutomationMirror extends Context.Service<AutomationMirror, AutomationMirrorShape>()(
  "t3/automation/AutomationMirror",
) {}

export const make = Effect.gen(function* () {
  const store = yield* AutomationStore;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* CoordinatorConfig;

  const baseUrl = Option.getOrUndefined(config.baseUrl)?.trim();
  const token = Option.getOrUndefined(config.token)?.trim();

  const deliver = Effect.fn("AutomationMirror.deliver")(function* (
    entry: AutomationMirrorOutboxEntry,
    attemptedAt: string,
  ) {
    if (baseUrl === undefined || baseUrl === "" || token === undefined || token === "") return;

    const url = automationMirrorUrl(baseUrl, entry.automationId);
    const request = (
      entry.operation === "put" ? HttpClientRequest.put(url) : HttpClientRequest.delete(url)
    ).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyText(entry.payloadJson ?? "{}", "application/json"),
    );

    const failure = yield* httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.as<string | null>(null),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
    );

    if (failure === null) {
      yield* store.completeMirrorOutbox(entry.automationId, entry.revision);
      return;
    }

    yield* store.retryMirrorOutbox(
      entry.automationId,
      entry.revision,
      automationMirrorRetryAt(attemptedAt, entry.attemptCount),
      failure,
    );
  });

  const flush = Effect.fn("AutomationMirror.flush")(function* (at?: string) {
    if (baseUrl === undefined || baseUrl === "" || token === undefined || token === "") return;
    const attemptedAt = at ?? DateTime.formatIso(yield* DateTime.now);
    const entries = yield* store.listMirrorOutboxDue(attemptedAt);
    yield* Effect.forEach(entries, (entry) => deliver(entry, attemptedAt), {
      concurrency: 4,
      discard: true,
    });
  });

  return AutomationMirror.of({ flush });
});

export const layer = Layer.effect(AutomationMirror, make);
