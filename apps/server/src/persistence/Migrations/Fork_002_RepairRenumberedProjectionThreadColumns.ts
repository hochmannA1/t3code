import * as Effect from "effect/Effect";

import Migration0042 from "./042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./043_ProjectionThreadsUnsettledAt.ts";

export default Effect.gen(function* () {
  yield* Migration0042;
  yield* Migration0043;
});
