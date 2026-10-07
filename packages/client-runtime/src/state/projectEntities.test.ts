import { EnvironmentId } from "@t3tools/contracts";
import { CookieConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

describe("environment project aggregation", () => {
  it("includes enabled projects from primary and shared environments with scoped refs", () => {
    const primaryId = EnvironmentId.make("environment-primary");
    const sharedId = EnvironmentId.make("kara-share:11111111-1111-4111-8111-111111111111");
    const disabledId = EnvironmentId.make("kara-share:22222222-2222-4222-8222-222222222222");
    const catalogValueAtom = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [
          primaryId,
          {
            target: new PrimaryConnectionTarget({
              environmentId: primaryId,
              label: "Primary",
              httpBaseUrl: "https://primary.example.test",
              wsBaseUrl: "wss://primary.example.test",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
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
          disabledId,
          {
            target: new CookieConnectionTarget({
              environmentId: disabledId,
              label: "Disabled shared project",
              shareId: "22222222-2222-4222-8222-222222222222",
              role: "read",
              version: "1",
              httpBaseUrl: "https://kara.example/shared-projects/other/t3/",
              wsBaseUrl: "wss://kara.example/shared-projects/other/t3/",
            }),
            profile: Option.none(),
            enabled: false,
          },
        ],
      ]),
    });
    const snapshots = new Map([
      [primaryId, Atom.make(v2ShellSnapshot)],
      [sharedId, Atom.make(v2ShellSnapshot)],
      [disabledId, Atom.make(v2ShellSnapshot)],
    ]);
    const projects = createEnvironmentProjectAtoms({
      catalogValueAtom,
      snapshotAtom: (environmentId) => snapshots.get(environmentId) ?? Atom.make(null),
    });
    const registry = AtomRegistry.make();

    expect(registry.get(projects.projectRefsAtom)).toEqual([
      { environmentId: primaryId, projectId: v2ShellSnapshot.projects[0]!.id },
      { environmentId: sharedId, projectId: v2ShellSnapshot.projects[0]!.id },
    ]);
    expect(registry.get(projects.projectsAtom).map((project) => project.environmentId)).toEqual([
      primaryId,
      sharedId,
    ]);
    registry.dispose();
  });
});
