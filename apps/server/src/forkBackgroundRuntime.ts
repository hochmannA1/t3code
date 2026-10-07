import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as AutomationMirror from "./automation/AutomationMirror.ts";
import * as AutomationService from "./automation/AutomationService.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import { forkParked } from "./serverActivation.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

// Keep the fork's maintenance cadence and coordinator ownership. The V2
// readiness gate additionally prevents dispatch before recovery has completed.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const memory = yield* MemoryService.MemoryService;
    const automations = yield* AutomationService.AutomationService;
    const mirror = yield* AutomationMirror.AutomationMirror;
    const scheduleLocally = AutomationService.shouldScheduleAutomationsLocally(
      process.env.T3_AUTOMATIONS_COORDINATOR_URL,
    );
    yield* forkParked(
      startup.awaitCommandReady.pipe(
        Effect.andThen(
          memory.tick().pipe(
            Effect.catch((error) =>
              Effect.logWarning("Memory maintenance is pending", { message: error.message }),
            ),
            Effect.repeat(Schedule.spaced("1 minute")),
          ),
        ),
      ),
    );
    yield* forkParked(startup.awaitCommandReady.pipe(Effect.andThen(memory.warmRecommendations())));
    const tick = Effect.all(
      [
        automations
          .tick(undefined, { scheduleLocally })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Scheduled prompt automation tick failed", { cause }),
            ),
          ),
        mirror
          .flush()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Scheduled prompt automation mirror delivery failed", { cause }),
            ),
          ),
      ],
      { concurrency: 2, discard: true },
    );
    yield* forkParked(
      startup.awaitCommandReady.pipe(
        Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced("15 seconds")))),
      ),
    );
  }),
);
