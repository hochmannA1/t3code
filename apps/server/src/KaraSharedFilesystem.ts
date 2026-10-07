// @effect-diagnostics nodeBuiltinImport:off
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { homedir } from "node:os";

export interface ProjectFilesystemRoot {
  id: string;
  workspaceRoot: string;
}

export interface ProjectFilesystemThread {
  worktreePath: string | null;
}

const runFile = promisify(execFile);

function denied(): Error {
  return new Error("Shared-project access denied.");
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function guardedProjectRoot(
  project: ProjectFilesystemRoot,
  allProjects: ReadonlyArray<ProjectFilesystemRoot>,
): Promise<void> {
  const root = await realpath(project.workspaceRoot);
  if (root.split(path.sep).includes(".git")) throw denied();
  const canonical = async (value: string) => {
    try {
      return await realpath(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(value);
      throw error;
    }
  };
  const codexHome = await canonical(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
  const t3Home = await canonical(process.env.T3CODE_HOME ?? path.join(homedir(), ".t3code"));
  const forbidden = [
    codexHome,
    t3Home,
    await canonical(path.join(t3Home, "userdata/state.sqlite")),
  ];
  // Never share a home/root that contains the owner's credentials or the T3
  // database. A standalone project below T3 home is fine when the database is
  // outside that project's root; mounting/sharing the whole home is not.
  if (forbidden.some((entry) => inside(root, entry)) || inside(codexHome, root)) throw denied();
  for (const other of allProjects) {
    if (other.id === project.id) continue;
    const otherRoot = await canonical(other.workspaceRoot);
    if (inside(root, otherRoot)) throw denied();
  }
}

export async function guardedFileInput(
  input: unknown,
  project: ProjectFilesystemRoot,
  threads: ReadonlyArray<ProjectFilesystemThread>,
  allProjects: ReadonlyArray<ProjectFilesystemRoot>,
  write: boolean,
): Promise<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw denied();
  const value = input as Record<string, unknown>;
  if (typeof value.cwd !== "string") throw denied();
  // Match an authoritative registered root before resolving it. Never accept a
  // caller-selected cwd merely because it happens to contain the requested file.
  const roots = [
    project.workspaceRoot,
    ...threads.flatMap((thread) => (thread.worktreePath ? [thread.worktreePath] : [])),
  ];
  const root = roots.find(
    (candidate) => path.resolve(candidate) === path.resolve(value.cwd as string),
  );
  if (!root) throw denied();
  await guardedProjectRoot({ ...project, workspaceRoot: root }, allProjects);
  const canonicalRoot = await realpath(root);
  const field =
    value.relativePath !== undefined
      ? "relativePath"
      : value.directoryPath !== undefined
        ? "directoryPath"
        : null;
  if (field === null) return { ...value, cwd: canonicalRoot };
  const requested = value[field];
  if (field === "directoryPath" && requested === "")
    return { ...value, cwd: canonicalRoot, directoryPath: "" };
  if (typeof requested !== "string" || !requested || /[\0\\]/u.test(requested)) throw denied();
  if (requested.split("/").some((part) => part === ".." || part === "." || part === ".git"))
    throw denied();
  const absolute = path.resolve(canonicalRoot, requested);
  if (!inside(canonicalRoot, absolute)) throw denied();
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(absolute);
  } catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== "ENOENT") throw denied();
    // For a new file, validate the closest existing parent. The original file
    // service repeats its own root/symlink checks before the actual mutation.
    let ancestor = path.dirname(absolute);
    for (;;) {
      try {
        canonicalTarget = await realpath(ancestor);
        break;
      } catch (failure) {
        if (
          (failure as NodeJS.ErrnoException).code !== "ENOENT" ||
          ancestor === path.dirname(ancestor)
        )
          throw denied();
        ancestor = path.dirname(ancestor);
      }
    }
  }
  if (!inside(canonicalRoot, canonicalTarget)) throw denied();
  return { ...value, cwd: canonicalRoot, [field]: path.relative(canonicalRoot, absolute) };
}

export async function guardedDiffRoot(
  project: ProjectFilesystemRoot,
  thread: ProjectFilesystemThread,
  allProjects: ReadonlyArray<ProjectFilesystemRoot>,
): Promise<void> {
  const cwd = thread.worktreePath ?? project.workspaceRoot;
  await guardedProjectRoot({ ...project, workspaceRoot: cwd }, allProjects);
  const root = await realpath(cwd);
  const result = await runFile(
    "git",
    ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
    { cwd: root, timeout: 5_000, maxBuffer: 16 * 1024 },
  );
  // The pinned checkpoint driver returns an unrestricted repository-wide patch.
  // A nested project must not expose diffs for private sibling directories.
  if ((await realpath(result.stdout.trim())) !== root) throw denied();
}
