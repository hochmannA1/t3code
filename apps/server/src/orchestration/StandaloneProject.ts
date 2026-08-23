import type { ClientOrchestrationCommand, StandaloneProjectCreateInput } from "@t3tools/contracts";
import { CommandId, OrchestrationDispatchCommandError, ProjectId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../os-jank.ts";

const DEFAULT_STANDALONE_PROJECTS_ROOT = "~/t3work/projects";
const MAX_PROJECT_SLUG_LENGTH = 64;

type ProjectCreateCommand = Extract<ClientOrchestrationCommand, { type: "project.create" }>;

function localDateKey(dateTime: DateTime.DateTime): string {
  const { day, month, year } = DateTime.toParts(dateTime);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function standaloneProjectSlug(request: string): string {
  const normalized = request
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .replaceAll("ł", "l")
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_PROJECT_SLUG_LENGTH)
    .replace(/-+$/gu, "");

  return normalized.length > 0 ? normalized : "new-task";
}

function slugWithCollisionSuffix(baseSlug: string, collisionIndex: number): string {
  if (collisionIndex === 1) return baseSlug;

  const suffix = `-${collisionIndex}`;
  const availableBaseLength = MAX_PROJECT_SLUG_LENGTH - suffix.length;
  const shortenedBase = baseSlug.slice(0, availableBaseLength).replace(/-+$/gu, "");
  return `${shortenedBase}${suffix}`;
}

function allocationError(message: string, cause: unknown) {
  return new OrchestrationDispatchCommandError({ message, cause });
}

export const createStandaloneProject = Effect.fn("StandaloneProject.create")(function* <R>(input: {
  readonly request: StandaloneProjectCreateInput["request"];
  readonly projectsRoot?: string;
  readonly dispatch: (
    command: ProjectCreateCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now;
  const createdAt = DateTime.formatIso(now);
  const date = localDateKey(DateTime.setZone(now, DateTime.zoneMakeLocal()));
  const baseSlug = standaloneProjectSlug(input.request);
  const projectsRoot = path.resolve(
    yield* expandHomePath(input.projectsRoot ?? DEFAULT_STANDALONE_PROJECTS_ROOT),
  );
  const dateRoot = path.join(projectsRoot, date);

  const projectId = ProjectId.make(
    yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        allocationError("Failed to generate a standalone project identifier.", cause),
      ),
    ),
  );
  const commandId = CommandId.make(
    yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        allocationError("Failed to generate a standalone project command identifier.", cause),
      ),
    ),
  );

  yield* fileSystem
    .makeDirectory(dateRoot, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        allocationError(`Failed to create standalone project directory '${dateRoot}'.`, cause),
      ),
    );

  let collisionIndex = 1;
  let title: string;
  let workspaceRoot: string;
  while (true) {
    title = slugWithCollisionSuffix(baseSlug, collisionIndex);
    workspaceRoot = path.join(dateRoot, title);
    const reserved = yield* fileSystem.makeDirectory(workspaceRoot).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        cause.reason._tag === "AlreadyExists"
          ? Effect.succeed(false)
          : Effect.fail(
              allocationError(
                `Failed to reserve standalone project directory '${workspaceRoot}'.`,
                cause,
              ),
            ),
      ),
    );
    if (reserved) break;
    collisionIndex += 1;
  }

  const result = yield* input
    .dispatch({
      type: "project.create",
      commandId,
      projectId,
      title,
      workspaceRoot,
      defaultModelSelection: null,
      createdAt,
    })
    .pipe(
      Effect.tapError(() =>
        fileSystem.remove(workspaceRoot, { recursive: true }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to remove unregistered standalone project directory", {
              workspaceRoot,
              cause,
            }),
          ),
        ),
      ),
    );

  return {
    projectId,
    title,
    workspaceRoot,
    sequence: result.sequence,
  };
});
