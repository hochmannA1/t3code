import { MemoryError, type MemoryEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MemoryService } from "../../../memory/MemoryService.ts";
import { MemorySourceReader } from "../../../memory/MemorySourceReader.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { MemoryToolkit, MemoryReadInput, MemoryRememberInput, MemorySearchInput } from "./tools.ts";

const notFound = () =>
  new MemoryError({ message: "Memory not found in the current project's or personal memory." });
const sourceMetadata = (entry: MemoryEntry) => ({
  sourceIds: entry.sourceIds.slice(0, 32),
  sourcesTruncated: entry.sourceIds.length > 32,
});

export function makeMemoryToolkitHandlers(
  memory: Pick<MemoryService["Service"], "forAgent" | "upsert" | "forget">,
  reader: Pick<MemorySourceReader["Service"], "projectForThread">,
) {
  const current = Effect.fn("MemoryToolkit.current")(function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has("memory"))
      return yield* new MemoryError({
        message: "Memory access is unavailable for this agent session.",
      });
    const projectId = yield* reader.projectForThread(invocation.threadId);
    const state = yield* memory.forAgent(invocation.threadId);
    return {
      projectId,
      entries: state.entries.filter(
        (entry) => entry.projectId === null || entry.projectId === projectId,
      ),
    };
  });

  return {
    memory_search: Effect.fn("MemoryToolkit.search")(function* (
      input: typeof MemorySearchInput.Type,
    ) {
      const { entries } = yield* current();
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
      return {
        matches: ranked.slice(0, input.limit ?? 8).map(({ entry }) => {
          const match = terms
            .map((term) => entry.text.toLocaleLowerCase().indexOf(term))
            .filter((index) => index >= 0);
          const start = Math.max(0, (match.length ? Math.min(...match) : 0) - 100);
          return {
            id: entry.id,
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
    memory_read: Effect.fn("MemoryToolkit.read")(function* ({ id }: typeof MemoryReadInput.Type) {
      const { entries } = yield* current();
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
    }: typeof MemoryReadInput.Type) {
      const { entries } = yield* current();
      if (!entries.some((entry) => entry.id === id)) return yield* notFound();
      yield* memory.forget({ id });
      return { forgotten: id };
    }),
  } satisfies Parameters<typeof MemoryToolkit.toLayer>[0];
}

export const MemoryToolkitHandlersLive = Layer.unwrap(
  Effect.gen(function* () {
    const memory = yield* MemoryService;
    const reader = yield* MemorySourceReader;
    return MemoryToolkit.toLayer(makeMemoryToolkitHandlers(memory, reader));
  }),
);
