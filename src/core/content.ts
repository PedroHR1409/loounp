export type ContentSource = "devto" | "medium";

export type EditorialCategory =
  | "news"
  | "technical-deep-dive"
  | "tutorial"
  | "opinion"
  | "product-announcement"
  | "promotional"
  | "repetitive"
  | "uncategorized";

export interface SourceOccurrence {
  source: ContentSource;
  externalId?: string;
  originalUrl: string;
  discoveredAt?: string;
}

export interface EditorialIndicator {
  code:
    | "superlative-language"
    | "repeated-buzzwords"
    | "promotional-call-to-action"
    | "few-verifiable-details"
    | "tutorial-cues"
    | "technical-detail-cues"
    | "news-cues"
    | "opinion-cues"
    | "product-launch-cues"
    | "repeated-content-cues";
  evidence: string;
}

export interface EditorialSignals {
  category: EditorialCategory;
  categoryConfidence: number;
  categoryEvidence: string[];
  /** Observable promotional/hype-like signals; this is not a verdict about truth or quality. */
  promotionalSignalScore: number;
  evidenceConfidence: number;
  promotionalIndicators: EditorialIndicator[];
}

export interface NormalizedContent {
  id: string;
  title: string;
  canonicalUrl: string;
  sourceOccurrences: SourceOccurrence[];
  author?: string;
  publishedAt?: string;
  description?: string;
  excerpt?: string;
  tags: string[];
  editorial?: EditorialSignals;
  assessment?: ContentAssessment;
  jevAssessment?: JevContentAssessment;
}

export type AssessedContentType =
  | "news"
  | "deep-dive"
  | "tutorial"
  | "opinion"
  | "announcement"
  | "other"
  | "uncertain";
export type TechnicalDepth = "low" | "medium" | "high" | "uncertain";

export interface ContentAssessment {
  profileRevision: number;
  promptVersion: string;
  model: string;
  groupMatches: Array<{ groupId: string; fit: number }>;
  personalUtility?: number;
  contentType?: AssessedContentType;
  technicalDepth?: TechnicalDepth;
  signals: Array<{ code: string; evidence: string }>;
  confidence: number;
  reason: string;
  assessedAt: string;
}

export interface JevScoreDimension {
  level: string;
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend: string[];
}
export interface JevContentAssessment {
  provider: "typesafe";
  model: string;
  rubricVersion: string;
  profileRevision: number;
  contentFingerprint: string;
  assessedAt: string;
  status: "valid" | "partial";
  utility?: JevScoreDimension;
  technicalDepth?: JevScoreDimension;
}

export interface ContentInput extends Omit<
  NormalizedContent,
  "canonicalUrl" | "sourceOccurrences"
> {
  url: string;
  sourceOccurrence: SourceOccurrence;
  canonicalUrl?: string;
  sourceOccurrences?: SourceOccurrence[];
}

export interface TopicInterest {
  /** Case-insensitive exact tag or phrase used for deterministic matching. */
  topic: string;
  importance: number;
}

export interface UserTopicProfile {
  topics: TopicInterest[];
  /** 0 favors durable items, 1 favors recent items. Defaults to an even mix. */
  recencyPreference?: number;
}

export type FeedbackEvent =
  | { kind: "open" | "save"; contentId: string; occurredAt: string }
  | {
      kind: "rate";
      contentId: string;
      value: "useful" | "not-useful";
      occurredAt: string;
    }
  | { kind: "hide" | "unhide"; contentId: string; occurredAt: string };

export interface RankingWeights {
  topicMatch: number;
  explicitTopicFeedback: number;
  weakTopicFeedback: number;
  directExplicitRating: number;
  open: number;
  save: number;
  recency: number;
  durable: number;
}

export interface RankingOptions {
  now?: Date;
  weights?: Partial<RankingWeights>;
  /** Historical items used to map past feedback to topics; only `contents` are returned. */
  catalog?: NormalizedContent[];
  /** Confirmed content preferences; omitted dimensions contribute no score. */
  preferredContentTypes?: AssessedContentType[];
  preferredTechnicalDepths?: TechnicalDepth[];
  evaluationMode?: "jev" | "reference";
}

export interface RankedContent {
  content: NormalizedContent;
  score: number;
  reasons: string[];
  components: {
    topicMatch: number;
    learnedTopicPreference: number;
    directExplicitRating: number;
    weakFeedback: number;
    recency: number;
    durable: number;
    personalUtility?: number;
    technicalSubstance?: number;
    groupPriority?: number;
    preferredFormatDepth?: number;
    diversityFeedback?: number;
  };
  matchedGroupIds?: string[];
  coverageGap?: boolean;
  utilityIsAssessed?: boolean;
  isExploratory?: boolean;
}

import type { InterestProfileV2 } from "./interest-profile";

const DEFAULT_WEIGHTS: RankingWeights = {
  topicMatch: 45,
  explicitTopicFeedback: 18,
  weakTopicFeedback: 3,
  directExplicitRating: 140,
  open: 2,
  save: 3,
  recency: 18,
  durable: 12,
};

const TRACKING_PARAM = /^(utm_[^=]+|fbclid|gclid|dclid|mc_cid|mc_eid|source)$/i;
const SUPERLATIVES = [
  "revolutionary",
  "game-changing",
  "revolucionário",
  "revolucionária",
  "incrível",
  "ultimate",
  "unprecedented",
  "sem precedentes",
];
const BUZZWORDS = [
  "revolutionary",
  "next-gen",
  "disruptive",
  "game-changing",
  "revolucionário",
  "disruptivo",
  "next generation",
  "state of the art",
];

export function canonicalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Content URLs must use HTTP or HTTPS.");
  }
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  url.searchParams.sort();
  return url.toString();
}

export function normalizeContent(input: ContentInput): NormalizedContent {
  const canonicalUrl = canonicalizeUrl(input.canonicalUrl ?? input.url);
  const occurrences = input.sourceOccurrences ?? [input.sourceOccurrence];
  return {
    id: input.id,
    title: input.title.trim(),
    canonicalUrl,
    sourceOccurrences: uniqueOccurrences(
      occurrences.map((occurrence) => ({
        ...occurrence,
        originalUrl: occurrence.originalUrl.trim(),
      })),
    ),
    ...(input.author ? { author: input.author.trim() } : {}),
    ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
    ...(input.description ? { description: input.description.trim() } : {}),
    ...(input.excerpt ? { excerpt: input.excerpt.trim() } : {}),
    tags: uniqueStrings(input.tags.map((tag) => tag.trim()).filter(Boolean)),
    ...(input.editorial ? { editorial: input.editorial } : {}),
  };
}

/** Merges only exact canonical URL matches; similar titles alone never merge. */
export function deduplicateByCanonicalUrl(
  items: NormalizedContent[],
): NormalizedContent[] {
  const byUrl = new Map<string, NormalizedContent>();
  for (const item of items) {
    const canonicalUrl = canonicalizeUrl(item.canonicalUrl);
    const existing = byUrl.get(canonicalUrl);
    if (!existing) {
      byUrl.set(canonicalUrl, {
        ...item,
        canonicalUrl,
        sourceOccurrences: uniqueOccurrences(item.sourceOccurrences),
      });
      continue;
    }
    byUrl.set(canonicalUrl, {
      ...existing,
      title: chooseRicher(existing.title, item.title) ?? existing.title,
      author: existing.author ?? item.author,
      publishedAt: earlierDate(existing.publishedAt, item.publishedAt),
      description: chooseRicher(existing.description, item.description),
      excerpt: chooseRicher(existing.excerpt, item.excerpt),
      tags: uniqueStrings([...existing.tags, ...item.tags]),
      sourceOccurrences: uniqueOccurrences([
        ...existing.sourceOccurrences,
        ...item.sourceOccurrences,
      ]),
      editorial: existing.editorial ?? item.editorial,
      assessment: existing.assessment ?? item.assessment,
    });
  }
  return [...byUrl.values()];
}

export function inferEditorialSignals(
  input: Pick<NormalizedContent, "title" | "description" | "excerpt">,
): EditorialSignals {
  const title = input.title.trim();
  const body = [input.description, input.excerpt]
    .filter(Boolean)
    .join(" ")
    .trim();
  const text = `${title} ${body}`.toLowerCase();
  const indicators: EditorialIndicator[] = [];
  const categoryEvidence: string[] = [];

  for (const word of SUPERLATIVES) {
    const found = findPhrase(text, word);
    if (found)
      indicators.push({ code: "superlative-language", evidence: found });
  }
  const buzzwordMatches = BUZZWORDS.filter(
    (word) => countPhrase(text, word) >= 2,
  );
  if (buzzwordMatches.length) {
    indicators.push({
      code: "repeated-buzzwords",
      evidence: `Repeated terms: ${buzzwordMatches.join(", ")}`,
    });
  }
  const promo =
    findPhrase(text, "sign up") ??
    findPhrase(text, "get started") ??
    findPhrase(text, "try it today") ??
    findPhrase(text, "comece agora");
  if (promo)
    indicators.push({ code: "promotional-call-to-action", evidence: promo });
  if (body.length < 80) {
    indicators.push({
      code: "few-verifiable-details",
      evidence: `Only ${body.length} characters of description/excerpt are available.`,
    });
  }

  const categories: Array<{
    category: EditorialCategory;
    cues: string[];
    indicator: EditorialIndicator["code"];
  }> = [
    {
      category: "tutorial",
      cues: [
        "how to",
        "step-by-step",
        "tutorial",
        "guide",
        "como fazer",
        "passo a passo",
      ],
      indicator: "tutorial-cues",
    },
    {
      category: "technical-deep-dive",
      cues: [
        "architecture",
        "benchmark",
        "implementation",
        "internals",
        "trade-offs",
        "arquitetura",
        "implementação",
      ],
      indicator: "technical-detail-cues",
    },
    {
      category: "news",
      cues: [
        "announces",
        "announced",
        "launches",
        "released",
        "acquires",
        "anunciou",
        "lançou",
      ],
      indicator: "news-cues",
    },
    {
      category: "opinion",
      cues: [
        "why i think",
        "in my opinion",
        "opinion:",
        "minha opinião",
        "por que eu acho",
      ],
      indicator: "opinion-cues",
    },
    {
      category: "product-announcement",
      cues: [
        "introducing",
        "now available",
        "we launched",
        "meet our",
        "apresentamos",
        "disponível agora",
      ],
      indicator: "product-launch-cues",
    },
  ];
  const matched = categories
    .map(({ category, cues, indicator }) => ({
      category,
      indicator,
      cues: cues.filter((cue) => text.includes(cue)),
    }))
    .filter((candidate) => candidate.cues.length > 0)
    .sort((a, b) => b.cues.length - a.cues.length);

  let category: EditorialCategory = "uncategorized";
  let categoryConfidence = 0.25;
  if (matched.length) {
    category = matched[0].category;
    categoryConfidence = Math.min(
      0.9,
      0.45 + matched[0].cues.length * 0.15 + (body.length >= 250 ? 0.1 : 0),
    );
    const evidence = matched[0].cues.map(
      (cue) => `Matched editorial cue: “${cue}”.`,
    );
    categoryEvidence.push(...evidence);
    indicators.push({
      code: matched[0].indicator,
      evidence: matched[0].cues.join(", "),
    });
  }

  const repeatedSentence = findRepeatedSentence(body);
  if (repeatedSentence) {
    category = "repetitive";
    categoryConfidence = Math.min(0.8, 0.55 + (body.length >= 250 ? 0.1 : 0));
    categoryEvidence.push(
      "A sentence of 30+ characters is repeated verbatim in the available text.",
    );
    indicators.push({
      code: "repeated-content-cues",
      evidence: repeatedSentence,
    });
  }

  const promotionalCategory =
    text.includes("sponsored") ||
    text.includes("affiliate") ||
    text.includes("buy now") ||
    text.includes("compre agora");
  if (promotionalCategory) {
    category = "promotional";
    categoryConfidence = Math.min(0.9, 0.55 + (body.length >= 250 ? 0.1 : 0));
    categoryEvidence.push(
      "Matched explicit sponsorship, affiliate, or purchase language.",
    );
  } else if (
    indicators.some(
      (indicator) => indicator.code === "promotional-call-to-action",
    )
  ) {
    category = "promotional";
    categoryConfidence = Math.min(categoryConfidence, 0.55);
    categoryEvidence.push(
      "A promotional call to action is present; this alone does not establish the article's overall intent.",
    );
  }

  const hypeCodes = new Set([
    "superlative-language",
    "repeated-buzzwords",
    "promotional-call-to-action",
    "few-verifiable-details",
  ]);
  const hypeCount = indicators.filter((indicator) =>
    hypeCodes.has(indicator.code),
  ).length;
  const evidenceConfidence =
    body.length >= 250 ? 0.8 : body.length >= 80 ? 0.55 : 0.3;
  return {
    category,
    categoryConfidence: round(categoryConfidence),
    categoryEvidence,
    promotionalSignalScore: round(Math.min(1, hypeCount / 4)),
    evidenceConfidence,
    promotionalIndicators: indicators,
  };
}

export function rankContent(
  contents: NormalizedContent[],
  profile: UserTopicProfile | InterestProfileV2,
  feedback: FeedbackEvent[],
  options: RankingOptions = {},
): RankedContent[] {
  if ("schemaVersion" in profile)
    return rankContentV2(contents, profile, feedback, options);
  const now = options.now ?? new Date();
  const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
  const hidden = currentlyHiddenIds(feedback);
  const learned = learnTopicPreferences(
    profile,
    options.catalog ?? contents,
    feedback,
    now,
    weights,
  );

  return contents
    .filter((content) => !hidden.has(content.id))
    .map((content) => {
      const matchingInterests = matchedInterests(content, profile);
      const topicMatch =
        matchingInterests.reduce(
          (sum, interest) => sum + clamp(interest.importance, 0, 1),
          0,
        ) * weights.topicMatch;
      const learnedTopicPreference = matchingInterests.reduce(
        (sum, interest) =>
          sum + (learned.get(interest.topic.toLowerCase()) ?? 0),
        0,
      );
      const latestRating = latestRatingFor(content.id, feedback);
      const directExplicitRating = latestRating
        ? latestRating.value === "useful"
          ? weights.directExplicitRating
          : -weights.directExplicitRating
        : 0;
      const weakFeedback = weakSignalsFor(content.id, feedback, now, weights);
      const ageDays = content.publishedAt
        ? Math.max(
            0,
            (now.getTime() - Date.parse(content.publishedAt)) / 86_400_000,
          )
        : Number.POSITIVE_INFINITY;
      const recency = Number.isFinite(ageDays)
        ? Math.max(0, 1 - ageDays / 30) *
          weights.recency *
          recencyPreference(profile)
        : 0;
      const durable =
        content.editorial?.category === "technical-deep-dive" ||
        content.editorial?.category === "tutorial"
          ? weights.durable * (1 - recencyPreference(profile))
          : 0;
      const score =
        topicMatch +
        learnedTopicPreference +
        directExplicitRating +
        weakFeedback +
        recency +
        durable;
      const reasons: string[] = [];
      if (topicMatch > 0)
        reasons.push(
          `Matches ${matchingInterests.map((interest) => interest.topic).join(", ")}, based on your declared priorities.`,
        );
      if (learnedTopicPreference > 0)
        reasons.push(
          "Your explicit ratings or reading activity favor this topic.",
        );
      if (learnedTopicPreference < 0)
        reasons.push("Your previous feedback lowers this topic's priority.");
      if (latestRating)
        reasons.push(
          `You rated this item ${latestRating.value === "useful" ? "useful" : "not useful"}.`,
        );
      if (weakFeedback > 0)
        reasons.push("A prior open or save is a weak positive signal.");
      if (recency > 0) reasons.push("Recently published.");
      if (durable > 0)
        reasons.push(
          "Tutorial or technical depth adds a durable-content signal.",
        );
      return {
        content,
        score,
        reasons,
        components: {
          topicMatch,
          learnedTopicPreference,
          directExplicitRating,
          weakFeedback,
          recency,
          durable,
        },
      };
    })
    .filter((ranked) => ranked.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.content.canonicalUrl.localeCompare(b.content.canonicalUrl),
    );
}

const V2_WEAK_FEEDBACK = { open: 2, save: 3 };

function rankContentV2(
  contents: NormalizedContent[],
  profile: InterestProfileV2,
  feedback: FeedbackEvent[],
  options: RankingOptions,
): RankedContent[] {
  const now = options.now ?? new Date();
  const hidden = currentlyHiddenIds(feedback);
  const notUseful = new Set(
    feedback
      .filter((event) => event.kind === "rate")
      .map((event) => event.contentId)
      .filter(
        (contentId) =>
          latestRatingFor(contentId, feedback)?.value === "not-useful",
      ),
  );
  const unique = deduplicateByCanonicalUrl(contents);
  const learningCatalog = deduplicateByCanonicalUrl(options.catalog ?? unique);
  const candidates = unique
    .flatMap((content) => {
      if (
        hidden.has(content.id) ||
        notUseful.has(content.id) ||
        profile.status !== "confirmed"
      )
        return [];
      const currentAssessment =
        content.assessment?.profileRevision === profile.revision
          ? content.assessment
          : undefined;
      if (!currentAssessment) return [];
      const assessments = currentAssessment.groupMatches;
      const matched = profile.interestGroups
        .map((group) => ({
          group,
          fit:
            assessments.find((match) => match.groupId === group.id)?.fit ?? 0,
        }))
        .filter(({ fit }) => fit > 0);
      const topicFit = matched.length
        ? Math.max(...matched.map(({ fit }) => clamp(fit, 0, 1)))
        : 0;
      const jevMode = options.evaluationMode === "jev";
      const jev = content.jevAssessment;
      const utility = jevMode
        ? jev?.utility
          ? shrinkScore(jev.utility, content)
          : 0.5
        : clamp(currentAssessment.personalUtility ?? 0.5, 0, 1);
      const latestRating = latestRatingFor(content.id, feedback);
      const directExplicitRating = latestRating?.value === "useful" ? 20 : 0;
      // Jev gets a small discovery lane for useful adjacent work that Luna did not
      // map to an existing topic. Requiring strong, confident utility keeps this
      // from becoming a general off-topic escape hatch.
      const isExploratory =
        jevMode &&
        topicFit <= 0 &&
        utility >= 0.75 &&
        (jev?.utility?.confidence ?? 0) >= 0.65;
      if (topicFit <= 0 && !isExploratory && directExplicitRating === 0)
        return [];
      const priority = matched.length
        ? Math.max(...matched.map(({ group }) => group.priority / 5))
        : 0;
      const contentType = currentAssessment?.contentType;
      const depth = currentAssessment?.technicalDepth;
      const preferred = jevMode
        ? jev?.technicalDepth
          ? shrinkScore(jev.technicalDepth, content)
          : 0.5
        : (contentType && options.preferredContentTypes?.includes(contentType)
            ? 0.5
            : 0) +
          (depth && options.preferredTechnicalDepths?.includes(depth)
            ? 0.5
            : 0);
      const ageDays = content.publishedAt
        ? Math.max(
            0,
            (now.getTime() - Date.parse(content.publishedAt)) / 86_400_000,
          )
        : Number.POSITIVE_INFINITY;
      const recency = Number.isFinite(ageDays)
        ? Math.max(0, 1 - ageDays / 30) * profile.recencyPreference
        : 0;
      const durable =
        contentType === "deep-dive" || contentType === "tutorial"
          ? 1 - profile.recencyPreference
          : 0;
      const recencyDurability = Math.max(recency, durable);
      const personalUtility = utility * 40;
      const technicalSubstance = jevMode ? preferred * 10 : 0;
      const topicMatch = topicFit * 30;
      const groupPriority = priority * 15;
      const preferredFormatDepth = jevMode ? 0 : preferred * 10;
      const recencyScore = recencyDurability * 5;
      if (jevMode && utility <= 0 && directExplicitRating === 0) return [];
      const weakFeedback = weakSignalsFor(content.id, feedback, now, {
        ...DEFAULT_WEIGHTS,
        open: V2_WEAK_FEEDBACK.open,
        save: V2_WEAK_FEEDBACK.save,
      });
      const diversityFeedback = groupFeedback(
        content.id,
        profile.revision,
        matched.map(({ group }) => group.id),
        learningCatalog,
        feedback,
        now,
      );
      const score =
        personalUtility +
        topicMatch +
        groupPriority +
        preferredFormatDepth +
        technicalSubstance +
        recencyScore +
        directExplicitRating +
        weakFeedback +
        diversityFeedback;
      if (score <= 0) return [];
      const reasons = isExploratory
        ? [
            `Descoberta adjacente: Jev estimou alta utilidade pessoal (${round(utility * 100)}%).`,
          ]
        : [
            `${jevMode ? "Jev personal utility" : "Personal utility"} ${round(utility * 100)}% and topic fit ${round(topicFit * 100)}%.`,
            `Matches ${matched.map(({ group }) => group.label).join(", ")}.`,
          ];
      if (directExplicitRating)
        reasons.push("You rated this item useful (+20).");
      if (weakFeedback)
        reasons.push("A prior open or save adds a weak, time-decayed signal.");
      if (diversityFeedback)
        reasons.push(
          "Your feedback on this interest group adjusts its priority.",
        );
      if (currentAssessment?.reason) reasons.push(currentAssessment.reason);
      const ranked: RankedContent = {
        content,
        score: round(score),
        reasons,
        matchedGroupIds: matched.map(({ group }) => group.id),
        utilityIsAssessed: jevMode ? Boolean(jev?.utility) : true,
        isExploratory,
        components: {
          topicMatch,
          learnedTopicPreference: diversityFeedback,
          directExplicitRating,
          weakFeedback,
          recency: recencyScore,
          durable: 0,
          personalUtility,
          technicalSubstance,
          groupPriority,
          preferredFormatDepth,
          diversityFeedback,
        },
      };
      return [ranked];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        comparePublicationDate(a.content.publishedAt, b.content.publishedAt) ||
        a.content.canonicalUrl.localeCompare(b.content.canonicalUrl),
    );

  const eligibleGroups = new Set(
    candidates.flatMap((item) => item.matchedGroupIds ?? []),
  );
  const coverageGap = eligibleGroups.size < 3;
  const topical = candidates
    .filter((item) => !item.isExploratory)
    .map((item) => ({ ...item, coverageGap }));
  const exploratory = candidates
    .filter((item) => item.isExploratory)
    .map((item) => ({ ...item, coverageGap: true }));
  // Reserve two positions in the first ten for adjacent discoveries, then keep
  // every remaining candidate available through the feed's "show more" control.
  const ordered: RankedContent[] = [];
  let nextExplore = 0;
  for (let index = 0; index < topical.length; index += 1) {
    ordered.push(topical[index]);
    if (
      (index + 1) % 4 === 0 &&
      ordered.length < 10 &&
      nextExplore < exploratory.length
    ) {
      ordered.push(exploratory[nextExplore++]);
    }
  }
  ordered.push(...exploratory.slice(nextExplore));
  return ordered;
}

function shrinkScore(
  dimension: JevContentAssessment["utility"],
  content: NormalizedContent,
): number {
  if (!dimension) return 0.5;
  const expected = dimension.score / 2;
  const coverage = Math.min(
    1,
    Math.max(
      0.2,
      [content.description, content.excerpt].filter(Boolean).join(" ").length /
        500,
    ),
  );
  const certainty = clamp(dimension.confidence * coverage, 0, 1);
  return 0.5 + (expected - 0.5) * certainty;
}

function groupFeedback(
  currentContentId: string,
  profileRevision: number,
  groupIds: string[],
  contents: NormalizedContent[],
  feedback: FeedbackEvent[],
  now: Date,
): number {
  let total = 0;
  for (const groupId of groupIds) {
    const members = contents.filter(
      (item) =>
        item.assessment?.profileRevision === profileRevision &&
        item.assessment.groupMatches.some(
          (match) => match.groupId === groupId && match.fit > 0,
        ),
    );
    for (const item of members) {
      if (item.id === currentContentId) continue;
      const rating = latestRatingFor(item.id, feedback);
      if (rating)
        total +=
          (rating.value === "useful" ? 1 : -1) *
          10 *
          ageDecay(rating.occurredAt, now);
    }
  }
  return clamp(total, -10, 10);
}

function comparePublicationDate(left?: string, right?: string): number {
  const leftDate = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightDate = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return rightDate - leftDate;
}

function learnTopicPreferences(
  profile: UserTopicProfile,
  contents: NormalizedContent[],
  feedback: FeedbackEvent[],
  now: Date,
  weights: RankingWeights,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const interest of profile.topics) {
    const topic = interest.topic.toLowerCase();
    let explicit = 0;
    let weak = 0;
    for (const content of contents) {
      if (!contentMatchesTopic(content, topic)) continue;
      const rating = latestRatingFor(content.id, feedback);
      if (rating) {
        explicit +=
          (rating.value === "useful" ? 1 : -1) *
          weights.explicitTopicFeedback *
          ageDecay(rating.occurredAt, now);
      }
      const lastWeakEvent = feedback
        .filter(
          (event) =>
            event.contentId === content.id &&
            (event.kind === "open" || event.kind === "save"),
        )
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
      if (lastWeakEvent)
        weak +=
          weights.weakTopicFeedback * ageDecay(lastWeakEvent.occurredAt, now);
    }
    result.set(
      topic,
      clamp(
        explicit + weak,
        -weights.explicitTopicFeedback,
        weights.explicitTopicFeedback,
      ),
    );
  }
  return result;
}

function weakSignalsFor(
  contentId: string,
  feedback: FeedbackEvent[],
  now: Date,
  weights: RankingWeights,
): number {
  const recentOpen = feedback
    .filter((event) => event.contentId === contentId && event.kind === "open")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const recentSave = feedback
    .filter((event) => event.contentId === contentId && event.kind === "save")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  return (
    (recentOpen ? weights.open * ageDecay(recentOpen.occurredAt, now) : 0) +
    (recentSave ? weights.save * ageDecay(recentSave.occurredAt, now) : 0)
  );
}

function latestRatingFor(
  contentId: string,
  feedback: FeedbackEvent[],
): Extract<FeedbackEvent, { kind: "rate" }> | undefined {
  return feedback
    .filter(
      (event): event is Extract<FeedbackEvent, { kind: "rate" }> =>
        event.contentId === contentId && event.kind === "rate",
    )
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
}

function currentlyHiddenIds(feedback: FeedbackEvent[]): Set<string> {
  const latest = new Map<string, FeedbackEvent>();
  for (const event of feedback) {
    if (event.kind !== "hide" && event.kind !== "unhide") continue;
    const current = latest.get(event.contentId);
    if (
      !current ||
      Date.parse(event.occurredAt) > Date.parse(current.occurredAt)
    )
      latest.set(event.contentId, event);
  }
  return new Set(
    [...latest].filter(([, event]) => event.kind === "hide").map(([id]) => id),
  );
}

function matchedInterests(
  content: NormalizedContent,
  profile: UserTopicProfile,
): TopicInterest[] {
  return profile.topics.filter((interest) =>
    contentMatchesTopic(content, interest.topic.toLowerCase()),
  );
}

function contentMatchesTopic(
  content: NormalizedContent,
  normalizedTopic: string,
): boolean {
  return (
    content.tags.some((tag) => tag.toLowerCase() === normalizedTopic) ||
    content.title.toLowerCase().includes(normalizedTopic) ||
    (content.description ?? "").toLowerCase().includes(normalizedTopic) ||
    (content.excerpt ?? "").toLowerCase().includes(normalizedTopic)
  );
}

function recencyPreference(profile: UserTopicProfile): number {
  return clamp(profile.recencyPreference ?? 0.5, 0, 1);
}

function ageDecay(occurredAt: string, now: Date): number {
  const ageDays = Math.max(
    0,
    (now.getTime() - Date.parse(occurredAt)) / 86_400_000,
  );
  return Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 90) : 0;
}

function uniqueOccurrences(
  occurrences: SourceOccurrence[],
): SourceOccurrence[] {
  const seen = new Set<string>();
  return occurrences.filter((occurrence) => {
    const key = `${occurrence.source}:${occurrence.externalId ?? canonicalizeUrl(occurrence.originalUrl)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chooseRicher(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function earlierDate(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function findPhrase(text: string, phrase: string): string | undefined {
  return text.includes(phrase.toLowerCase()) ? phrase : undefined;
}

function countPhrase(text: string, phrase: string): number {
  return text.split(phrase.toLowerCase()).length - 1;
}

function findRepeatedSentence(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const rawSentence of text.split(/[.!?\n]+/)) {
    const sentence = rawSentence.trim().toLowerCase().replace(/\s+/g, " ");
    if (sentence.length < 30) continue;
    const count = (counts.get(sentence) ?? 0) + 1;
    counts.set(sentence, count);
    if (count === 2) return rawSentence.trim().slice(0, 120);
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
