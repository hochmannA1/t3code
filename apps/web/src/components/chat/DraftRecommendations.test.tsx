import { describe, expect, it } from "vite-plus/test";

import {
  recommendationProjectIdForDraft,
  recommendationsForDraft,
  shouldShowDraftRecommendationRetry,
  type DraftRecommendation,
} from "./DraftRecommendations";
import { ProjectId } from "@t3tools/contracts";

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

describe("recommendationProjectIdForDraft", () => {
  const projectId = ProjectId.make("project-1");

  it("uses null for projectless drafts even if the prior project is still in memory", () => {
    expect(recommendationProjectIdForDraft(true, projectId)).toBeNull();
  });

  it("waits for a project draft to resolve its active project", () => {
    expect(recommendationProjectIdForDraft(false, undefined)).toBeUndefined();
    expect(recommendationProjectIdForDraft(false, projectId)).toBe(projectId);
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
