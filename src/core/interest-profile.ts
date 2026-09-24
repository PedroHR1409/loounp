import type { UserTopicProfile } from "./content";

export type InterestProfileStatus = "draft" | "confirmed";
export type ExamplePolarity = "positive" | "negative";

export interface InterestGroup {
  id: string;
  label: string;
  summary: string;
  priority: number;
  objectives: string[];
  subtopics: string[];
  retrievalTerms: { devtoTags: string[]; mediumTopics: string[] };
}

export interface InterestExample {
  polarity: ExamplePolarity;
  url?: string;
  title: string;
  excerpt: string;
}

export interface InterestProfileV2 {
  schemaVersion: 2;
  status: InterestProfileStatus;
  intentText: string;
  interestGroups: InterestGroup[];
  positiveTraits: string[];
  deprioritizeTraits: string[];
  examples: InterestExample[];
  mediumFeeds: string[];
  recencyPreference: number;
  revision: number;
}

export interface LegacyInterestProfile {
  topics?: Array<{ topic: string; importance: number }>;
  mediumFeeds?: string[];
  recencyPreference?: number;
}

const MAX_INTENT_LENGTH = 4000;
const MAX_EXAMPLES = 20;
const MAX_EXAMPLE_TEXT = 1500;

export function normalizeInterestProfile(value: unknown): InterestProfileV2 {
  if (!isRecord(value) || value.schemaVersion !== 2)
    throw new TypeError("Interest profile must use schemaVersion 2.");
  if (value.status !== "draft" && value.status !== "confirmed")
    throw new TypeError("Interest profile status must be draft or confirmed.");
  const intentText = boundedString(
    value.intentText,
    MAX_INTENT_LENGTH,
    "intentText",
    true,
  );
  if (!Array.isArray(value.interestGroups) || value.interestGroups.length > 12)
    throw new TypeError("Interest profile must contain at most 12 groups.");
  const ids = new Set<string>();
  const interestGroups = value.interestGroups.map(
    (entry, index): InterestGroup => {
      if (!isRecord(entry))
        throw new TypeError(`Interest group ${index} must be an object.`);
      const id = boundedString(entry.id, 80, "group id", true);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id))
        throw new TypeError(
          "Interest group IDs must be unique stable identifiers.",
        );
      ids.add(id);
      const priority = entry.priority;
      if (
        typeof priority !== "number" ||
        !Number.isInteger(priority) ||
        priority < 1 ||
        priority > 5
      )
        throw new TypeError("Group priority must be an integer from 1 to 5.");
      const retrievalTerms = isRecord(entry.retrievalTerms)
        ? entry.retrievalTerms
        : {};
      return {
        id,
        label: boundedString(entry.label, 120, "group label", true),
        summary: boundedString(entry.summary, 500, "group summary"),
        priority,
        objectives: stringList(entry.objectives, 12, 200, "objectives"),
        subtopics: stringList(entry.subtopics, 20, 120, "subtopics"),
        retrievalTerms: {
          devtoTags: normalizeTerms(
            retrievalTerms.devtoTags,
            20,
            30,
            "Dev.to tags",
          ),
          mediumTopics: normalizeTerms(
            retrievalTerms.mediumTopics,
            20,
            80,
            "Medium topics",
          ),
        },
      };
    },
  );
  if (!Array.isArray(value.examples) || value.examples.length > MAX_EXAMPLES)
    throw new TypeError("Interest profile must contain at most 20 examples.");
  const examples = value.examples.map((entry, index): InterestExample => {
    if (
      !isRecord(entry) ||
      (entry.polarity !== "positive" && entry.polarity !== "negative")
    )
      throw new TypeError(`Example ${index} has invalid polarity.`);
    const url =
      entry.url === undefined || entry.url === ""
        ? undefined
        : safeHttpUrl(entry.url);
    return {
      polarity: entry.polarity,
      ...(url ? { url } : {}),
      title: boundedString(entry.title, MAX_EXAMPLE_TEXT, "example title"),
      excerpt: boundedString(
        entry.excerpt,
        MAX_EXAMPLE_TEXT,
        "example excerpt",
      ),
    };
  });
  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0
  )
    throw new TypeError("Profile revision must be a non-negative integer.");
  const recencyPreference = value.recencyPreference;
  if (
    typeof recencyPreference !== "number" ||
    !Number.isFinite(recencyPreference) ||
    recencyPreference < 0 ||
    recencyPreference > 1
  )
    throw new TypeError("Recency preference must be between 0 and 1.");
  return {
    schemaVersion: 2,
    status: value.status,
    intentText,
    interestGroups,
    positiveTraits: stringList(
      value.positiveTraits,
      30,
      120,
      "positive traits",
    ),
    deprioritizeTraits: stringList(
      value.deprioritizeTraits,
      30,
      120,
      "deprioritize traits",
    ),
    examples,
    mediumFeeds: normalizeFeeds(value.mediumFeeds),
    recencyPreference,
    revision,
  };
}

export function isInterestProfileV2(
  value: unknown,
): value is InterestProfileV2 {
  try {
    normalizeInterestProfile(value);
    return true;
  } catch {
    return false;
  }
}

/** Converts known v1 fields into a reviewable draft while retaining the legacy feed until confirmation. */
export function adaptLegacyProfile(
  legacy: LegacyInterestProfile,
): InterestProfileV2 {
  const seen = new Set<string>();
  const topics = (Array.isArray(legacy.topics) ? legacy.topics : []).slice(
    0,
    12,
  );
  const interestGroups = topics.flatMap(({ topic, importance }, index) => {
    if (typeof topic !== "string" || !topic.trim()) return [];
    const label = topic.trim().slice(0, 120);
    const id = stableId(label, index);
    if (seen.has(id)) return [];
    seen.add(id);
    const priority = Math.max(
      1,
      Math.min(
        5,
        Math.round((Number.isFinite(importance) ? importance : 0.5) * 5),
      ),
    );
    return [
      {
        id,
        label,
        summary: "Imported from your previous topic profile.",
        priority,
        objectives: [label],
        subtopics: [label],
        retrievalTerms: { devtoTags: [], mediumTopics: [] },
      },
    ];
  });
  const recency = legacy.recencyPreference ?? 0.5;
  return normalizeInterestProfile({
    schemaVersion: 2,
    status: "draft",
    intentText: "Review and confirm your imported interests.",
    interestGroups,
    positiveTraits: [],
    deprioritizeTraits: [],
    examples: [],
    mediumFeeds: legacy.mediumFeeds ?? [],
    recencyPreference: Number.isFinite(recency)
      ? Math.max(0, Math.min(1, recency))
      : 0.5,
    revision: 0,
  });
}

/** Drafts never replace the legacy profile as the active retrieval/ranking contract. */
export function activeProfile(
  v2: InterestProfileV2 | undefined,
  legacy: LegacyInterestProfile,
): InterestProfileV2 | UserTopicProfile {
  if (v2?.status === "confirmed") return normalizeInterestProfile(v2);
  return {
    topics: (legacy.topics ?? [])
      .filter(
        (topic) =>
          typeof topic.topic === "string" && Number.isFinite(topic.importance),
      )
      .map((topic) => ({ ...topic })),
    recencyPreference: legacy.recencyPreference,
  };
}

function stableId(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "interest"}-${index + 1}`;
}

function normalizeTerms(
  value: unknown,
  maxItems: number,
  maxLength: number,
  label: string,
): string[] {
  return stringList(value, maxItems, maxLength, label).map((term) =>
    term.toLowerCase().replace(/\s+/g, " "),
  );
}

function normalizeFeeds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new TypeError("At most 30 Medium feeds are allowed.");
  const feeds = value.map((feed) => safeHttpUrl(feed, true));
  return [...new Set(feeds)];
}

function safeHttpUrl(value: unknown, mediumOnly = false): string {
  if (typeof value !== "string") throw new TypeError("URL must be a string.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("URL must be valid.");
  }
  if (
    url.protocol !== "https:" ||
    (mediumOnly &&
      !(url.hostname === "medium.com" || url.hostname.endsWith(".medium.com")))
  ) {
    throw new TypeError(
      mediumOnly
        ? "Medium feeds must use HTTPS on medium.com."
        : "Example URLs must use HTTPS.",
    );
  }
  url.hash = "";
  return url.toString();
}

function stringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new TypeError(`${label} must contain at most ${maxItems} strings.`);
  const normalized = value.map((item) =>
    boundedString(item, maxLength, label, true).replace(/\s+/g, " "),
  );
  return [...new Set(normalized.map((item) => item.toLocaleLowerCase()))].map(
    (key) => normalized.find((item) => item.toLocaleLowerCase() === key)!,
  );
}

function boundedString(
  value: unknown,
  maxLength: number,
  label: string,
  required = false,
): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if ((required && !text) || text.length > maxLength)
    throw new TypeError(
      `${label} must be ${required ? "non-empty and " : ""}at most ${maxLength} characters.`,
    );
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
