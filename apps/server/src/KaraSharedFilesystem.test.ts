// @effect-diagnostics nodeBuiltinImport:off - these tests exercise native filesystem symlink behavior.
import { expect, it } from "@effect/vitest";
import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedFileInput, guardedProjectRoot } from "./KaraSharedFilesystem.ts";

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

it("restricts file access to registered roots and blocks symlink escapes", async () => {
  const root = await temporaryDirectory("kara-shared-root-");
  const outside = await temporaryDirectory("kara-shared-outside-");
  try {
    const project = { id: "project-shared", workspaceRoot: root };
    await writeFile(join(outside, "secret.txt"), "private");
    await symlink(outside, join(root, "external"));
    const allowed = await guardedFileInput(
      { cwd: root, relativePath: "new/file.txt" },
      project,
      [],
      [project],
      true,
    );
    expect(allowed.cwd).toBe(await realpath(root));
    await expect(
      guardedFileInput(
        { cwd: root, relativePath: "external/secret.txt" },
        project,
        [],
        [project],
        false,
      ),
    ).rejects.toThrow();
    await expect(
      guardedFileInput({ cwd: outside, relativePath: "secret.txt" }, project, [], [project], false),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("rejects roots that contain another registered project", async () => {
  const root = await temporaryDirectory("kara-shared-parent-");
  try {
    const nested = join(root, "private-project");
    await mkdir(nested);
    await expect(
      guardedProjectRoot({ id: "project-shared", workspaceRoot: root }, [
        { id: "project-shared", workspaceRoot: root },
        { id: "project-private", workspaceRoot: nested },
      ]),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
