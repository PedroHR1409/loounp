import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalizeUrl,
  deduplicateByCanonicalUrl,
  inferEditorialSignals,
  normalizeContent,
  rankContent,
  type ContentInput,
  type FeedbackEvent,
  type NormalizedContent,
} from "./content";

const now = new Date("2026-09-20T12:00:00.000Z");

function content(overrides: Partial<ContentInput> = {}): NormalizedContent {
  const input: ContentInput = {
    id: "article-1",
    title: "Understanding vector search",
    url: "https://example.com/vector-search?utm_source=feed#intro",
    sourceOccurrence: {
      source: "devto",
      externalId: "1",
      originalUrl: "https://example.com/vector-search",
    },
    tags: ["AI"],
    publishedAt: "2026-09-19T12:00:00.000Z",
    ...overrides,
  };
  return normalizeContent(input);
}

test("canonicalizes only known tracking details and preserves meaningful path/query data", () => {
  assert.equal(
    canonicalizeUrl(
      "HTTPS://Example.COM/articles/SomeCase/?utm_source=x&lang=en&source=rss#section",
    ),
    "https://example.com/articles/SomeCase?lang=en",
  );
});

test("deduplicates exact canonical URLs, merges source occurrences and metadata, but not title-only matches", () => {
  const first = content({ id: "one", title: "Short title", tags: ["AI"] });
  const second = content({
    id: "two",
    title: "A richer title for the same article",
    url: "https://example.com/vector-search?utm_medium=medium",
    sourceOccurrence: {
      source: "medium",
      originalUrl: "https://example.com/vector-search?utm_medium=medium",
    },
    tags: ["Data", "ai"],
  });
  const sameTitleDifferentUrl = content({
    id: "three",
    url: "https://other.example/vector-search",
  });

  const result = deduplicateByCanonicalUrl([
    first,
    second,
    sameTitleDifferentUrl,
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].title, "A richer title for the same article");
  assert.deepEqual(result[0].tags, ["AI", "Data"]);
  assert.equal(result[0].sourceOccurrences.length, 2);
});

test("strong explicit feedback dominates topic fit, recency, and weak open/save signals", () => {
  const usefulElsewhere = content({
    id: "rated-useful",
    title: "Deep AI system architecture",
    tags: ["AI"],
  });
  const notUsefulMatch = content({
    id: "rated-negative",
    title: "AI announcement",
    tags: ["AI"],
    publishedAt: now.toISOString(),
  });
  const feedback: FeedbackEvent[] = [
    {
      kind: "rate",
      contentId: usefulElsewhere.id,
      value: "useful",
      occurredAt: now.toISOString(),
    },
    {
      kind: "rate",
      contentId: notUsefulMatch.id,
      value: "not-useful",
      occurredAt: now.toISOString(),
    },
    ...Array.from({ length: 10 }, (_, index) => ({
      kind: index % 2 === 0 ? ("open" as const) : ("save" as const),
      contentId: notUsefulMatch.id,
      occurredAt: now.toISOString(),
    })),
  ];

  const result = rankContent(
    [notUsefulMatch, usefulElsewhere],
    { topics: [{ topic: "AI", importance: 1 }] },
    feedback,
    { now },
  );

  assert.equal(result[0].content.id, usefulElsewhere.id);
  assert.equal(
    result.find((item) => item.content.id === notUsefulMatch.id),
    undefined,
  );
});

test("open and save remain weak signals compared with an explicit rating", () => {
  const opened = content({ id: "opened", title: "AI guide" });
  const rated = content({ id: "rated", title: "AI guide" });
  const result = rankContent(
    [opened, rated],
    { topics: [{ topic: "AI", importance: 0 }] },
    [
      ...Array.from({ length: 50 }, () => [
        {
          kind: "open" as const,
          contentId: "opened",
          occurredAt: now.toISOString(),
        },
        {
          kind: "save" as const,
          contentId: "opened",
          occurredAt: now.toISOString(),
        },
      ]).flat(),
      {
        kind: "rate",
        contentId: "rated",
        value: "useful",
        occurredAt: now.toISOString(),
      },
    ],
    { now },
  );

  assert.equal(result[0].content.id, "rated");
  assert.ok(
    result[0].components.directExplicitRating >
      result[1].components.weakFeedback,
  );
  assert.ok(result[1].components.weakFeedback <= 5);
});

test("filters zero-score items from the legacy feed", () => {
  const zero = content({
    id: "zero",
    title: "Unrelated post",
    tags: ["wordpress"],
    publishedAt: "2026-01-01T00:00:00.000Z",
  });
  const positive = content({
    id: "positive",
    title: "AI guide",
    tags: ["AI"],
    publishedAt: now.toISOString(),
  });
  const ranked = rankContent(
    [zero, positive],
    { topics: [{ topic: "AI", importance: 1 }] },
    [],
    { now },
  );

  assert.deepEqual(
    ranked.map((item) => item.content.id),
    ["positive"],
  );
});

test("topic ratings influence future items for that topic and hiding is distinct from rating", () => {
  const ratedArticle = content({
    id: "old",
    tags: ["AI"],
    publishedAt: "2026-09-10T12:00:00.000Z",
  });
  const futureAI = content({ id: "future-ai", tags: ["AI"] });
  const futureData = content({ id: "future-data", tags: ["Data"] });
  const feedback: FeedbackEvent[] = [
    {
      kind: "rate",
      contentId: "old",
      value: "useful",
      occurredAt: now.toISOString(),
    },
    { kind: "hide", contentId: "future-data", occurredAt: now.toISOString() },
  ];

  const result = rankContent(
    [ratedArticle, futureData, futureAI],
    { topics: [{ topic: "AI", importance: 0 }] },
    feedback,
    { now },
  );

  assert.ok(!result.some((item) => item.content.id === "future-data"));
  const learned = rankContent(
    [futureAI],
    { topics: [{ topic: "AI", importance: 0 }] },
    feedback,
    {
      now,
      catalog: [ratedArticle],
    },
  )[0];
  assert.ok(learned.components.learnedTopicPreference > 0);
});

test("editorial heuristic reports observable signals with limited-evidence uncertainty, not a truth claim", () => {
  const sparse = inferEditorialSignals({
    title: "The revolutionary next-gen AI revolution",
    description: "Sign up today!",
  });
  assert.ok(sparse.promotionalSignalScore > 0);
  assert.ok(sparse.evidenceConfidence < 0.5);
  assert.ok(
    sparse.promotionalIndicators.some(
      (indicator) => indicator.code === "few-verifiable-details",
    ),
  );
  assert.ok(
    sparse.promotionalIndicators.some(
      (indicator) => indicator.code === "promotional-call-to-action",
    ),
  );
  assert.ok(!("isHype" in sparse));

  const tutorial = inferEditorialSignals({
    title: "How to build a vector search service",
    description: [
      "Step-by-step guide with practical exercises and a worked example.",
      "The first chapter sets up a local development environment for the project.",
      "Next, readers compare two retrieval strategies using the same small dataset.",
      "A final exercise asks readers to measure latency and explain the results.",
      "The author includes a checklist for adapting the lesson to another service.",
    ].join(" "),
  });
  assert.equal(tutorial.category, "tutorial");
  assert.ok(tutorial.categoryEvidence.length > 0);
  assert.ok(tutorial.evidenceConfidence > sparse.evidenceConfidence);

  const repetitive = inferEditorialSignals({
    title: "Repeated passage",
    description:
      "This paragraph contains the same repeated sentence in the sample. This paragraph contains the same repeated sentence in the sample.",
  });
  assert.equal(repetitive.category, "repetitive");
  assert.ok(repetitive.promotionalSignalScore < 1);
});

test("ranking exposes traceable reasons and hides only items with a current hide event", () => {
  const visible = content({ id: "visible", tags: ["AI"] });
  const hidden = content({ id: "hidden", tags: ["AI"] });
  const result = rankContent(
    [visible, hidden],
    { topics: [{ topic: "AI", importance: 0.8 }] },
    [
      { kind: "hide", contentId: "hidden", occurredAt: now.toISOString() },
      {
        kind: "unhide",
        contentId: "hidden",
        occurredAt: "2026-09-20T12:01:00.000Z",
      },
    ],
    { now },
  );

  assert.equal(result.length, 2);
  assert.ok(
    result[0].reasons.some((reason) => reason.includes("declared priorities")),
  );
});

test("v2 ranking combines confirmed assessment signals and excludes zero-score items", () => {
  const profile = v2Profile();
  const qualified = v2Content("qualified", "data-platform", 0.8, 0.7);
  const unrelated = v2Content("unrelated", "data-platform", 0, 0);
  const result = rankContent([unrelated, qualified], profile, [], { now });

  assert.deepEqual(
    result.map((item) => item.content.id),
    ["qualified"],
  );
  assert.equal(result[0].components.personalUtility, 28);
  assert.ok(result[0].score > 0);
});

test("Jev mode uses separate utility and technical Scores, shrinks uncertainty once, and preserves explicit feedback", () => {
  const strong = v2Content("jev-strong", "data-platform", 0.8, 0.1);
  strong.description = "Concrete evidence and implementation details. ".repeat(
    12,
  );
  const weak = v2Content("jev-weak", "data-platform", 0.8, 0.95);
  const zero = v2Content("jev-zero", "data-platform", 0.8, 0.95);
  zero.description = "Concrete evidence and implementation details. ".repeat(
    12,
  );
  const jev = (
    utilityScore: number,
    depthScore: number,
    confidence: number,
  ) => ({
    provider: "typesafe" as const,
    model: "jev-latest",
    rubricVersion: "jev-product-decisions-v1",
    profileRevision: 1,
    contentFingerprint: "fixture",
    assessedAt: now.toISOString(),
    status: "valid" as const,
    utility: {
      level: utilityScore > 1 ? "high" : "low",
      score: utilityScore,
      confidence,
      probabilities: { "0": 0, "1": 0, "2": 1 },
      legend: ["low", "partial", "high"],
    },
    technicalDepth: {
      level: depthScore > 1 ? "high" : "low",
      score: depthScore,
      confidence,
      probabilities: { "0": 1, "1": 0, "2": 0 },
      legend: ["low", "medium", "high"],
    },
  });
  strong.jevAssessment = jev(2, 2, 1);
  weak.jevAssessment = jev(0, 0, 1);
  zero.jevAssessment = jev(0, 2, 1);
  const rated = v2Content("jev-rated", "data-platform", 0.8, 0);
  rated.description = "Concrete evidence and implementation details. ".repeat(
    12,
  );
  rated.jevAssessment = jev(0, 0, 1);
  const ranked = rankContent(
    [weak, rated, strong, zero],
    v2Profile(),
    [
      {
        kind: "rate",
        contentId: rated.id,
        value: "useful",
        occurredAt: now.toISOString(),
      },
      { kind: "open", contentId: weak.id, occurredAt: now.toISOString() },
      { kind: "save", contentId: weak.id, occurredAt: now.toISOString() },
      { kind: "open", contentId: zero.id, occurredAt: now.toISOString() },
      { kind: "save", contentId: zero.id, occurredAt: now.toISOString() },
    ],
    { now, evaluationMode: "jev" },
  );

  assert.deepEqual(
    ranked.map((item) => item.content.id),
    ["jev-strong", "jev-weak", "jev-rated"],
  );
  const weakRanked = ranked.find((item) => item.content.id === "jev-weak")!;
  const ratedRanked = ranked.find((item) => item.content.id === "jev-rated")!;
  assert.equal(weakRanked.components.personalUtility, 16);
  assert.equal(ratedRanked.components.personalUtility, 0);
  assert.equal(ratedRanked.components.technicalSubstance, 0);
  assert.equal(ratedRanked.components.directExplicitRating, 20);
  assert.equal(ranked[0].components.personalUtility, 40);
  assert.equal(ranked[0].components.technicalSubstance, 10);
  assert.equal(ranked[0].components.preferredFormatDepth, 0);
  assert.ok(
    ratedRanked.components.directExplicitRating >
      weakRanked.components.weakFeedback,
  );
});

test("v2 direct useful feedback is strong while open and save decay as weak signals", () => {
  const profile = v2Profile();
  const plain = v2Content("plain", "data-platform", 0.5, 0.5);
  const useful = v2Content("useful", "data-platform", 0.5, 0.5);
  const weak = v2Content("weak", "data-platform", 0.5, 0.5);
  const ranked = rankContent(
    [plain, useful, weak],
    profile,
    [
      {
        kind: "rate",
        contentId: "useful",
        value: "useful",
        occurredAt: now.toISOString(),
      },
      { kind: "open", contentId: "weak", occurredAt: now.toISOString() },
      { kind: "save", contentId: "weak", occurredAt: now.toISOString() },
      {
        kind: "rate",
        contentId: "plain",
        value: "not-useful",
        occurredAt: now.toISOString(),
      },
    ],
    { now },
  );

  assert.deepEqual(
    ranked.map(({ content: item }) => item.id),
    ["useful", "weak"],
  );
  assert.equal(ranked[0].components.directExplicitRating, 20);
  assert.equal(ranked[1].components.weakFeedback, 5);
});

test("a partial Jev assessment uses neutral only for its missing dimension", () => {
  const partial = v2Content("jev-partial", "data-platform", 0.8, 0.5);
  partial.description = "Concrete evidence and implementation details. ".repeat(
    12,
  );
  partial.jevAssessment = {
    provider: "typesafe",
    model: "jev-1.13.0",
    rubricVersion: "jev-product-decisions-v1",
    profileRevision: 1,
    contentFingerprint: "fixture",
    assessedAt: now.toISOString(),
    status: "partial",
    utility: {
      level: "high",
      score: 2,
      confidence: 1,
      probabilities: { "0": 0, "1": 0, "2": 1 },
      legend: ["low", "partial", "high"],
    },
  };

  const [ranked] = rankContent([partial], v2Profile(), [], {
    now,
    evaluationMode: "jev",
  });

  assert.equal(ranked.components.personalUtility, 40);
  assert.equal(ranked.components.technicalSubstance, 5);
});

test("v2 ranking keeps candidates beyond the former ten-item ceiling", () => {
  const profile = v2Profile();
  const items = [
    ...Array.from({ length: 6 }, (_, index) =>
      v2Content(`a-${index}`, "data-platform", 0.9, 0.9),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      v2Content(`b-${index}`, "fabric", 0.8, 0.8),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      v2Content(`c-${index}`, "llm-systems", 0.7, 0.7),
    ),
  ];

  const ranked = rankContent(items, profile, [], { now });
  assert.equal(ranked.length, 10);
  assert.equal(
    ranked.filter((item) => item.matchedGroupIds?.includes("data-platform"))
      .length,
    6,
  );
  assert.ok(ranked.every((item) => item.coverageGap === false));
});

test("Jev admits a small high-confidence lane for useful adjacent discoveries", () => {
  const adjacent = v2Content("adjacent-ai-project", "data-platform", 0, 0);
  adjacent.description =
    "A practical implementation with architecture choices, code, and measurable trade-offs. ".repeat(
      8,
    );
  adjacent.jevAssessment = {
    provider: "typesafe",
    model: "jev-latest",
    rubricVersion: "jev-product-decisions-v1",
    profileRevision: 1,
    contentFingerprint: "fixture",
    assessedAt: now.toISOString(),
    status: "valid",
    utility: {
      level: "high",
      score: 2,
      confidence: 0.9,
      probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
      legend: ["low", "partial", "high"],
    },
    technicalDepth: {
      level: "high",
      score: 2,
      confidence: 0.9,
      probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
      legend: ["low", "medium", "high"],
    },
  };

  const [ranked] = rankContent([adjacent], v2Profile(), [], {
    now,
    evaluationMode: "jev",
  });

  assert.equal(ranked.content.id, "adjacent-ai-project");
  assert.equal(ranked.isExploratory, true);
  assert.match(ranked.reasons[0], /Descoberta adjacente/);
});

test("ignores matches from an assessment created for an older profile revision", () => {
  const profile = v2Profile();
  const stale = {
    ...content({ id: "stale", title: "Legacy match", tags: ["legacy"] }),
    assessment: {
      ...v2Content("stale", "data-platform", 1, 1).assessment!,
      profileRevision: 0,
    },
  };

  assert.deepEqual(rankContent([stale], profile, [], { now }), []);
});

test("does not infer an assessed topic match from tags when the current assessment rejects that group", () => {
  const item = v2Content("topic-only", "data-platform", 0, 0.9);
  assert.deepEqual(rankContent([item], v2Profile(), [], { now }), []);
});

test("withholds v2 items without a current personal-utility assessment", () => {
  const item = content({
    id: "fallback",
    title: "Data platform migration guide",
    tags: ["data-platform"],
  });
  assert.deepEqual(rankContent([item], v2Profile(), [], { now }), []);
});

test("does not count a useful rating twice as same-item group feedback", () => {
  const item = v2Content("single", "data-platform", 0.8, 0.7);
  const ranked = rankContent(
    [item],
    v2Profile(),
    [
      {
        kind: "rate",
        contentId: item.id,
        value: "useful",
        occurredAt: now.toISOString(),
      },
    ],
    { now },
  );

  assert.equal(ranked[0].components.directExplicitRating, 20);
  assert.equal(ranked[0].components.diversityFeedback, 0);
});

test("uses imported history in the learning catalog without displaying the history items", () => {
  const candidate = v2Content("new-content", "data-platform", 0.7, 0.7);
  const archiveSeed = v2Content("medium-seed", "data-platform", 0.3, 0.5);
  const ranked = rankContent(
    [candidate],
    v2Profile(),
    [
      {
        kind: "rate",
        contentId: archiveSeed.id,
        value: "useful",
        occurredAt: now.toISOString(),
      },
    ],
    { now, catalog: [candidate, archiveSeed] },
  );

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].content.id, candidate.id);
  assert.equal(ranked[0].components.diversityFeedback, 10);
});

function v2Profile() {
  return {
    schemaVersion: 2 as const,
    status: "confirmed" as const,
    intentText: "Learn useful engineering patterns",
    interestGroups: [
      {
        id: "data-platform",
        label: "Data platforms",
        summary: "Data systems",
        priority: 5,
        objectives: ["data-platform"],
        subtopics: ["data-platform"],
        retrievalTerms: { devtoTags: [], mediumTopics: [] },
      },
      {
        id: "fabric",
        label: "Fabric",
        summary: "Fabric",
        priority: 4,
        objectives: ["fabric"],
        subtopics: ["fabric"],
        retrievalTerms: { devtoTags: [], mediumTopics: [] },
      },
      {
        id: "llm-systems",
        label: "LLM systems",
        summary: "LLMs",
        priority: 3,
        objectives: ["llm-systems"],
        subtopics: ["llm-systems"],
        retrievalTerms: { devtoTags: [], mediumTopics: [] },
      },
    ],
    positiveTraits: [],
    deprioritizeTraits: [],
    examples: [],
    mediumFeeds: [],
    recencyPreference: 0.5,
    revision: 1,
  };
}

function v2Content(
  id: string,
  groupId: string,
  fit: number,
  utility: number,
): NormalizedContent {
  return {
    ...content({
      id,
      title: `Guide for ${groupId}`,
      tags: [groupId],
      url: `https://example.com/${id}`,
    }),
    assessment: {
      profileRevision: 1,
      promptVersion: "1",
      model: "test",
      groupMatches: [{ groupId, fit }],
      personalUtility: utility,
      contentType: "tutorial",
      technicalDepth: "medium",
      signals: [],
      confidence: 0.8,
      reason: "Matches the stated learning goal.",
      assessedAt: now.toISOString(),
    },
  };
}
