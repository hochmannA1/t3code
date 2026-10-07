import type {
  MemoryRecommendation,
  MemoryRecommendationType,
  MemoryGetRecommendationsResult,
} from "@t3tools/contracts";
import {
  CalendarClockIcon,
  FileTextIcon,
  MessageSquarePlusIcon,
  RotateCcwIcon,
  type LucideIcon,
} from "lucide-react";

export type DraftRecommendation = MemoryRecommendation;

interface DraftRecommendationsProps {
  readonly recommendations: ReadonlyArray<DraftRecommendation>;
  readonly reason?: MemoryGetRecommendationsResult["reason"];
  readonly isPending: boolean;
  readonly retryable: boolean;
  readonly error: string | null;
  readonly onSelect: (recommendation: DraftRecommendation) => void;
  readonly onRetry: () => void;
}

const MAX_VISIBLE_RECOMMENDATIONS = 2;

export function recommendationsForDraft(
  recommendations: ReadonlyArray<DraftRecommendation>,
): ReadonlyArray<DraftRecommendation> {
  return recommendations.slice(0, MAX_VISIBLE_RECOMMENDATIONS);
}

export function shouldShowDraftRecommendationRetry(input: {
  readonly hasRecommendations: boolean;
  readonly isPending: boolean;
  readonly retryable: boolean;
  readonly error: string | null;
}) {
  return !input.hasRecommendations && !input.isPending && (input.retryable || input.error !== null);
}

const RECOMMENDATION_ICONS = {
  task: MessageSquarePlusIcon,
  automation: CalendarClockIcon,
  page: FileTextIcon,
} satisfies Record<MemoryRecommendationType, LucideIcon>;

function RecommendationIcon({ kind }: { readonly kind: MemoryRecommendationType }) {
  const Icon = RECOMMENDATION_ICONS[kind];

  return <Icon aria-hidden="true" className="size-4.5 shrink-0" data-recommendation-icon={kind} />;
}

export function DraftRecommendations({
  recommendations,
  isPending,
  reason,
  retryable,
  error,
  onSelect,
  onRetry,
}: DraftRecommendationsProps) {
  const visible = recommendationsForDraft(recommendations);
  const showRetry = shouldShowDraftRecommendationRetry({
    hasRecommendations: visible.length > 0,
    isPending,
    retryable,
    error,
  });

  if (visible.length === 0 && !showRetry) {
    return (
      <div
        className="mx-auto mt-3 flex min-h-[5.625rem] w-full max-w-3xl items-start justify-center gap-2 pt-3 text-xs text-muted-foreground"
        data-draft-recommendations="empty"
      >
        <span role="status">
          {isPending
            ? "Preparing suggestions from memory…"
            : reason === "disabled"
              ? "Enable memory in Settings to see suggestions."
              : reason === "no-memories"
                ? "Suggestions appear as memories are saved."
                : "No suggestions from memory yet."}
        </span>
        {!isPending && reason !== "disabled" ? (
          <button
            type="button"
            onClick={onRetry}
            className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
          >
            Refresh
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="mx-auto mt-3 min-h-[5.625rem] w-full max-w-3xl"
      data-draft-recommendations="true"
    >
      {visible.length > 0 ? (
        <ul aria-label="Suggested tasks" className="flex flex-col gap-0.5">
          {visible.map((recommendation) => (
            <li key={recommendation.id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                data-recommendation-kind={recommendation.type}
                onClick={() => onSelect(recommendation)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center text-foreground/85">
                  <RecommendationIcon kind={recommendation.type} />
                </span>
                <span className="min-w-0 flex-1 truncate leading-snug">{recommendation.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex justify-center">
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground outline-none hover:bg-accent/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRetry}
          >
            <RotateCcwIcon aria-hidden="true" className="size-3.5" />
            Try suggestions again
          </button>
        </div>
      )}
    </div>
  );
}
