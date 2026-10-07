import { describe, expect, it } from "vite-plus/test";

import {
  recommendationsForDraft,
  shouldShowDraftRecommendationRetry,
  type DraftRecommendation,
} from "./DraftRecommendations";

const recommendations: ReadonlyArray<DraftRecommendation> = [
  {
    id: "automation",
    type: "automation",
    label: "Review this project every Friday",
    prompt: "Create a weekly project review automation.",
  },
  {
    id: "page",
    type: "page",
    label: "Turn the release notes into a Page",
    prompt: "Create a Page from the latest release notes.",
  },
  {
    id: "task",
    type: "task",
    label: "Continue the release cleanup",
    prompt: "Continue the release cleanup from memory.",
  },
];

describe("recommendationsForDraft", () => {
  it("keeps the first two recommendations in their generated order", () => {
    expect(recommendationsForDraft(recommendations)).toEqual(recommendations.slice(0, 2));
  });

  it("does not mutate the server result while filtering", () => {
    const snapshot = [...recommendations];

    recommendationsForDraft(recommendations);

    expect(recommendations).toEqual(snapshot);
  });
});

describe("shouldShowDraftRecommendationRetry", () => {
  it("keeps loading and settled empty results quiet", () => {
    expect(
      shouldShowDraftRecommendationRetry({
        hasRecommendations: false,
        isPending: true,
        retryable: true,
        error: null,
      }),
    ).toBe(false);
    expect(
      shouldShowDraftRecommendationRetry({
        hasRecommendations: false,
        isPending: false,
        retryable: false,
        error: null,
      }),
    ).toBe(false);
  });

  it("offers retry for generation or transport failures only after loading settles", () => {
    expect(
      shouldShowDraftRecommendationRetry({
        hasRecommendations: false,
        isPending: false,
        retryable: true,
        error: null,
      }),
    ).toBe(true);
    expect(
      shouldShowDraftRecommendationRetry({
        hasRecommendations: false,
        isPending: false,
        retryable: false,
        error: "Unavailable",
      }),
    ).toBe(true);
  });

  it("never replaces available recommendations with retry", () => {
    expect(
      shouldShowDraftRecommendationRetry({
        hasRecommendations: true,
        isPending: false,
        retryable: true,
        error: "Unavailable",
      }),
    ).toBe(false);
  });
});
