import * as Path from "effect/Path";
import { MemoryError, type MemoryEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MemoryService } from "../../../memory/MemoryService.ts";
import { MemorySourceReader } from "../../../memory/MemorySourceReader.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import {
  MemoryToolkit,
  MemoryReadInput,
  MemoryRememberInput,
  MemorySearchInput,
  MemoryListInput,
  MemoryForgetInput,
} from "./tools.ts";

const notFound = () =>
  new MemoryError({
    message:
      "Memory not found in the requested scope. Use scope all for an entry from a cross-project inventory.",
  });
const sourceMetadata = (entry: MemoryEntry) => ({
  sourceIds: entry.sourceIds.slice(0, 32),
  sourcesTruncated: entry.sourceIds.length > 32,
});

export function makeMemoryToolkitHandlers(
  memory: Pick<MemoryService["Service"], "forAgent" | "upsert" | "forget">,
  reader: Pick<MemorySourceReader["Service"], "projectForThread">,
  path: Pick<Path.Path, "join">,
) {
  const current = Effect.fn("MemoryToolkit.current")(function* (scope?: "current" | "all") {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has("memory"))
      return yield* new MemoryError({
        message: "Memory access is unavailable for this agent session.",
      });
    const projectId = yield* reader.projectForThread(invocation.threadId);
    const state = yield* memory.forAgent(invocation.threadId, scope);
    return {
      projectId,
      entries: state.entries,
      status: state.status,
    };
  });

  return {
    memory_search: Effect.fn("MemoryToolkit.search")(function* (
      input: typeof MemorySearchInput.Type,
    ) {
      const { entries } = yield* current(input.scope);
      const terms = [...new Set(input.query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
      const ranked = entries
        .map((entry) => {
          const title = entry.title.toLocaleLowerCase();
          const keywords = entry.keywords.join(" ").toLocaleLowerCase();
          const text = entry.text.toLocaleLowerCase();
          return {
            entry,
            score: terms.reduce(
              (score, term) =>
                score +
                (title.includes(term) ? 4 : 0) +
                (keywords.includes(term) ? 3 : 0) +
                (text.includes(term) ? 1 : 0),
              0,
            ),
          };
        })
        .filter(({ score }) => score > 0)
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            b.entry.updatedAt.localeCompare(a.entry.updatedAt) ||
            a.entry.id.localeCompare(b.entry.id),
        );
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 8;
      return {
        total: ranked.length,
        available: entries.length,
        hint:
          ranked.length === 0
            ? "No keyword matches. Use memory_list for an inventory, or scope all to search across projects."
            : null,
        nextOffset: offset + limit < ranked.length ? offset + limit : null,
        matches: ranked.slice(offset, offset + limit).map(({ entry }) => {
          const match = terms
            .map((term) => entry.text.toLocaleLowerCase().indexOf(term))
            .filter((index) => index >= 0);
          const start = Math.max(0, (match.length ? Math.min(...match) : 0) - 100);
          return {
            id: entry.id,
            projectId: entry.projectId,
            title: entry.title,
            scope: entry.projectId === null ? ("personal" as const) : ("project" as const),
            snippet: entry.text.slice(start, start + 500),
            keywords: entry.keywords,
            ...sourceMetadata(entry),
            updatedAt: entry.updatedAt,
          };
        }),
      };
    }),
    memory_list: Effect.fn("MemoryToolkit.list")(function* (input: typeof MemoryListInput.Type) {
      const { entries, status } = yield* current(input.scope ?? "all");
      const ordered = entries.toSorted(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 20;
      return {
        entries: ordered
          .slice(offset, offset + limit)
          .map(({ id, projectId, title, keywords, pinned, updatedAt }) => ({
            id,
            projectId,
            title,
            keywords,
            pinned,
            updatedAt,
          })),
        total: ordered.length,
        nextOffset: offset + limit < ordered.length ? offset + limit : null,
        status,
        indexPath: path.join(status.memoryDirectory, "MEMORY.md"),
        summaryPath: path.join(status.memoryDirectory, "memory_summary.md"),
      };
    }),
    memory_read: Effect.fn("MemoryToolkit.read")(function* ({
      id,
      scope,
    }: typeof MemoryReadInput.Type) {
      const { entries } = yield* current(scope);
      const entry = entries.find((entry) => entry.id === id);
      if (!entry) return yield* notFound();
      const { sourceIds, sourcesTruncated } = sourceMetadata(entry);
      return { entry: { ...entry, sourceIds }, sourcesTruncated };
    }),
    memory_remember: Effect.fn("MemoryToolkit.remember")(function* (
      input: typeof MemoryRememberInput.Type,
    ) {
      const { projectId } = yield* current();
      return yield* memory.upsert({
        projectId: input.scope === "personal" ? null : projectId,
        title: input.title,
        text: input.text,
        keywords: input.keywords ?? [],
        pinned: true,
      });
    }),
    memory_forget: Effect.fn("MemoryToolkit.forget")(function* ({
      id,
    }: typeof MemoryForgetInput.Type) {
      const { entries, projectId } = yield* current();
      if (
        !entries.some(
          (entry) => entry.id === id && (entry.projectId === null || entry.projectId === projectId),
        )
      )
        return yield* notFound();
      yield* memory.forget({ id });
      return { forgotten: id };
    }),
  } satisfies Parameters<typeof MemoryToolkit.toLayer>[0];
}

export const MemoryToolkitHandlersLive = Layer.unwrap(
  Effect.gen(function* () {
    const memory = yield* MemoryService;
    const reader = yield* MemorySourceReader;
    const path = yield* Path.Path;
    return MemoryToolkit.toLayer(makeMemoryToolkitHandlers(memory, reader, path));
  }),
);
