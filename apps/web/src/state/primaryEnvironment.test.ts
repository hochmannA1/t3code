import { EnvironmentId } from "@t3tools/contracts";
import {
  CookieConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { selectPrimaryEnvironmentId } from "./primaryEnvironment";

describe("selectPrimaryEnvironmentId", () => {
  it("selects the primary environment rather than a shared project", () => {
    const sharedId = EnvironmentId.make("kara-share:11111111-1111-4111-8111-111111111111");
    const primaryId = EnvironmentId.make("environment-primary");
    expect(
      selectPrimaryEnvironmentId({
        isReady: true,
        entries: new Map([
          [
            sharedId,
            {
              target: new CookieConnectionTarget({
                environmentId: sharedId,
                label: "Shared project",
                shareId: "11111111-1111-4111-8111-111111111111",
                role: "edit",
                version: "1",
                httpBaseUrl: "https://kara.example/shared-projects/share/t3/",
                wsBaseUrl: "wss://kara.example/shared-projects/share/t3/",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ],
          [
            primaryId,
            {
              target: new PrimaryConnectionTarget({
                environmentId: primaryId,
                label: "Primary",
                httpBaseUrl: "https://kara.example/t3/",
                wsBaseUrl: "wss://kara.example/t3/",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ],
        ]),
      }),
    ).toBe(primaryId);
  });
});
