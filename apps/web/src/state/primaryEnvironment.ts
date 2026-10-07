import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";

export function selectPrimaryEnvironmentId(catalog: EnvironmentCatalogState) {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") {
      return environmentId;
    }
  }
  return null;
}

export const primaryEnvironmentIdAtom = Atom.make((get) =>
  selectPrimaryEnvironmentId(get(environmentCatalog.catalogValueAtom)),
).pipe(Atom.withLabel("web-primary-environment-id"));
