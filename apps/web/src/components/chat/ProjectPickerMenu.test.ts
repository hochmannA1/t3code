import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { filterProjectPickerOptions } from "./ProjectPickerMenu";

const options = [
  {
    ref: scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("t3code")),
    value: "local:t3code",
    label: "t3code",
  },
  {
    ref: scopeProjectRef(EnvironmentId.make("local"), ProjectId.make("kara-code")),
    value: "local:kara-code",
    label: "kara-code",
  },
];

describe("filterProjectPickerOptions", () => {
  it("matches project names without case sensitivity", () => {
    expect(filterProjectPickerOptions(options, "KARA")).toEqual([options[1]]);
  });

  it("returns all projects for an empty search", () => {
    expect(filterProjectPickerOptions(options, "  ")).toEqual(options);
  });
});
