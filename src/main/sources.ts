import { XMLParser } from "fast-xml-parser";
import {
  normalizeContent,
  deduplicateByCanonicalUrl,
  type ContentInput,
  type NormalizedContent,
} from "../core/content";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});
const MAX_MEDIUM_FEED_BYTES = 2 * 1024 * 1024;

type InterestGroup = {
  subtopics?: string[];
  retrievalTerms?: {
    devtoTags?: string[];
    mediumTopicSlugs?: string[];
    mediumTopics?: string[];
    devto?: string[];
    medium?: string[];
  };
};
const EXAMPLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "about",
  "after",
  "building",
  "complete",
  "from",
  "guide",
  "into",
  "just",
  "only",
  "personal",
  "routine",
  "started",
  "system",
  "that",
  "their",
  "this",
  "with",
  "your",
  "how",
  "what",
  "when",
  "where",
  "which",
  "will",
  "have",
  "some",
  "more",
  "than",
  "they",
  "were",
  "using",
  "without",
  "zero",
  "scratch",
  "million",
  "documents",
]);

export type ConfirmedInterestProfile = {
  status: "confirmed";
  interestGroups: InterestGroup[];
  examples?: Array<{
    polarity: "positive" | "negative";
    title: string;
    excerpt?: string;
  }>;
  retrievalTerms?: {
    devtoTags?: string[];
    mediumTopicSlugs?: string[];
    devto?: string[];
    medium?: string[];
  };
};

/** Explicitly useful items can refine retrieval, while broad history remains a weaker discovery hint. */
export function withBehavioralExamples(
  profile: ConfirmedInterestProfile,
  ratedUsefulTitles: string[],
  ratedNotUsefulTitles: string[],
  archivedTitles: string[],
): ConfirmedInterestProfile {
  const rated = ratedUsefulTitles
    .slice(0, 3)
    .map((title) => ({ polarity: "positive" as const, title, excerpt: "" }));
  const ratedAgainst = ratedNotUsefulTitles
    .slice(0, 3)
    .map((title) => ({ polarity: "negative" as const, title, excerpt: "" }));
  const archived = archivedTitles.map((title) => ({
    polarity: "positive" as const,
    title,
    excerpt: "",
  }));
  const profilePositive = (profile.examples ?? [])
    .filter((example) => example.polarity === "positive")
    .slice(0, 5);
  const profileNegative = (profile.examples ?? [])
    .filter((example) => example.polarity === "negative")
    .slice(0, 3);
  const examples = [
    ...rated,
    ...ratedAgainst,
    ...archived.slice(0, 3),
    ...profilePositive,
    ...profileNegative,
    ...archived.slice(3),
  ]
    .filter(
      (example, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.title.toLowerCase() === example.title.toLowerCase(),
        ) === index,
    )
    .slice(0, 16);
  return { ...profile, examples };
}

function cleanText(input: unknown): string {
  return String(input ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|source|ref_|mc_cid|mc_eid)/i.test(key))
      url.searchParams.delete(key);
  return url.toString().replace(/\/$/, "");
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => {
      if (!term || seen.has(term)) return false;
      seen.add(term);
      return true;
    });
}

function confirmedProfile(
  input?: ConfirmedInterestProfile,
): ConfirmedInterestProfile | undefined {
  return input?.status === "confirmed" ? input : undefined;
}

function devtoTagsFromProfile(profile: ConfirmedInterestProfile): string[] {
  const terms = [
    ...(profile.retrievalTerms?.devtoTags ??
      profile.retrievalTerms?.devto ??
      []),
    ...profile.interestGroups.flatMap((group) => [
      ...(group.retrievalTerms?.devtoTags ?? group.retrievalTerms?.devto ?? []),
      ...(group.subtopics ?? []),
    ]),
  ];
  const core = uniqueTerms(
    terms.map((term) => term.toLowerCase().replace(/[^a-z0-9]/g, "")),
  ).filter((tag) => tag.length >= 2 && tag.length <= 30);
  const examples = exampleSearchTerms(profile, core);
  return [...core.slice(0, 12 - examples.length), ...examples].slice(0, 12);
}

/** Positive examples contribute a few discovery queries without displacing the user's core topics. */
function exampleSearchTerms(
  profile: ConfirmedInterestProfile,
  protectedTerms: string[] = [],
): string[] {
  const terms = profile.examples ?? [];
  const ranked: string[] = [];
  const negative = new Set<string>();
  const protectedSet = new Set(
    protectedTerms.map((term) => term.toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
  for (const example of terms) {
    if (example.polarity !== "negative") continue;
    for (const match of example.title
      .toLowerCase()
      .matchAll(/[a-z][a-z0-9+#-]{1,29}/g)) {
      const term = match[0].replace(/[^a-z0-9]/g, "");
      if (term.length >= 2 && !EXAMPLE_STOP_WORDS.has(term)) negative.add(term);
    }
  }
  for (const example of terms) {
    if (example.polarity !== "positive") continue;
    for (const match of example.title
      .toLowerCase()
      .matchAll(/[a-z][a-z0-9+#-]{1,29}/g)) {
      const term = match[0].replace(/[^a-z0-9]/g, "");
      if (
        term.length >= 2 &&
        !EXAMPLE_STOP_WORDS.has(term) &&
        !ranked.includes(term) &&
        (!negative.has(term) || protectedSet.has(term))
      )
        ranked.push(term);
    }
  }
  return ranked.slice(0, 4);
}

function mediumFeedsFromProfile(
  feeds: string[],
  profile?: ConfirmedInterestProfile,
): string[] {
  const primarySlugs = profile
    ? [
        ...(profile.retrievalTerms?.mediumTopicSlugs ??
          profile.retrievalTerms?.medium ??
          []),
        ...profile.interestGroups.flatMap((group) => [
          ...(group.retrievalTerms?.mediumTopicSlugs ??
            group.retrievalTerms?.mediumTopics ??
            group.retrievalTerms?.medium ??
            []),
          ...(group.subtopics ?? []),
        ]),
      ]
    : [];
  const examples = profile ? exampleSearchTerms(profile, primarySlugs) : [];
  const generatedSlugs = [
    ...primarySlugs.slice(0, 12 - examples.length),
    ...examples,
  ];
  const generatedFeeds = uniqueTerms(
    generatedSlugs.map((slug) =>
      slug
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    ),
  )
    .filter(Boolean)
    .slice(0, 12)
    .map((slug) => `https://medium.com/feed/tag/${encodeURIComponent(slug)}`);
  const seen = new Set<string>();
  return [...feeds, ...generatedFeeds].filter((feed) => {
    try {
      const url = new URL(feed.trim());
      url.hash = "";
      for (const key of [...url.searchParams.keys()])
        if (/^(utm_|source|ref_|mc_cid|mc_eid)/i.test(key))
          url.searchParams.delete(key);
      const normalized = url.toString().replace(/\/$/, "");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    } catch {
      if (seen.has(feed)) return false;
      seen.add(feed);
      return true;
    }
  });
}

function mapDevtoArticle(
  article: Record<string, unknown>,
): NormalizedContent | undefined {
  try {
    const url = canonicalUrl(
      String(article.canonical_url || article.url || ""),
    );
    const input: ContentInput = {
      id: `devto:${article.id}`,
      title: cleanText(article.title),
      url,
      sourceOccurrence: {
        source: "devto",
        externalId: String(article.id),
        originalUrl: String(article.url ?? url),
      },
      author: String(
        (article.user as Record<string, unknown> | undefined)?.name ??
          "Dev.to author",
      ),
      publishedAt: String(article.published_at ?? new Date().toISOString()),
      description: cleanText(article.description),
      tags: Array.isArray(article.tag_list) ? article.tag_list.map(String) : [],
    };
    const item = normalizeContent(input);
    return item.title && item.canonicalUrl.startsWith("https://")
      ? item
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDevto(
  topics: string[] | ConfirmedInterestProfile,
): Promise<NormalizedContent[]> {
  const aliases: Record<string, string[]> = {
    "artificial intelligence": ["ai", "machinelearning"],
    "data engineering": ["dataengineering"],
    "microsoft fabric": ["microsoftfabric", "fabric"],
    "large language models": ["llm", "ai"],
    llms: ["llm", "ai"],
    "ai agents": ["ai", "agents"],
  };
  const isProfile = !Array.isArray(topics);
  const profile = isProfile
    ? confirmedProfile(topics as ConfirmedInterestProfile)
    : undefined;
  const terms = isProfile
    ? profile
      ? devtoTagsFromProfile(profile)
      : []
    : (topics as string[]).flatMap(
        (topic) =>
          aliases[topic.trim().toLowerCase()] ?? [
            topic.toLowerCase().replace(/[^a-z0-9]/g, ""),
          ],
      );
  const tags = uniqueTerms(terms)
    .filter((tag) => tag.length >= 2 && tag.length <= 30)
    .slice(0, isProfile ? 12 : 5);
  const responses = await Promise.allSettled(
    tags.map(async (tag) => {
      const url = new URL("https://dev.to/api/articles");
      url.searchParams.set("tag", tag);
      url.searchParams.set("per_page", "30");
      const response = await fetch(url, {
        headers: { accept: "application/vnd.forem.api-v1+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(`Dev.to (${tag}): HTTP ${response.status}`);
      const articles: unknown = await response.json();
      if (!Array.isArray(articles))
        throw new Error(`Dev.to (${tag}): resposta inválida`);
      return articles as Record<string, unknown>[];
    }),
  );
  const rejected = responses.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected.length === responses.length && rejected.length > 0)
    throw new Error(rejected.map((r) => String(r.reason)).join("; "));
  const articles = responses
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map(mapDevtoArticle)
    .filter((item): item is NormalizedContent => Boolean(item));
  return deduplicateByCanonicalUrl(articles);
}

function mapMediumEntry(
  item: Record<string, any>,
): NormalizedContent | undefined {
  try {
    const linkValue = Array.isArray(item.link)
      ? (item.link.find(
          (link: Record<string, unknown>) => link["@_rel"] === "alternate",
        ) ?? item.link[0])
      : item.link;
    const rawLink =
      typeof linkValue === "string"
        ? linkValue
        : (linkValue?.["@_href"] ?? item.guid);
    const url = canonicalUrl(String(rawLink ?? ""));
    const author =
      item["dc:creator"] ?? item.author?.name ?? item.author ?? "Medium author";
    const description = cleanText(
      item.description ?? item.summary ?? item.content,
    );
    const body = cleanText(item["content:encoded"] ?? item.content ?? "");
    const input: ContentInput = {
      id: `medium:${url}`,
      title: cleanText(item.title),
      url,
      sourceOccurrence: { source: "medium", externalId: url, originalUrl: url },
      author: cleanText(author),
      publishedAt: String(
        item.pubDate ??
          item.published ??
          item.updated ??
          new Date().toISOString(),
      ),
      description: (description || body).slice(0, 4000),
      tags: [item.category].flat().filter(Boolean).map(cleanText),
      excerpt: body.slice(0, 4000),
    };
    const normalized = normalizeContent(input);
    return normalized.title && normalized.canonicalUrl.startsWith("https://")
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchMedium(
  feeds: string[],
  profile?: ConfirmedInterestProfile,
): Promise<NormalizedContent[]> {
  const requestedFeeds = mediumFeedsFromProfile(
    feeds,
    confirmedProfile(profile),
  );
  const responses = await Promise.allSettled(
    requestedFeeds.map(async (feed) => {
      const url = new URL(feed);
      if (
        url.protocol !== "https:" ||
        !/(^|\.)medium\.com$/i.test(url.hostname)
      )
        throw new Error(`Feed Medium inválido: ${feed}`);
      return parser.parse(await fetchMediumXml(url)) as Record<string, any>;
    }),
  );
  const rejected = responses.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected.length === responses.length && rejected.length > 0)
    throw new Error(rejected.map((r) => String(r.reason)).join("; "));
  const items = responses
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .flatMap((feed) => {
      const channel = feed.rss?.channel ?? feed.feed;
      const entries = channel?.item ?? channel?.entry ?? [];
      return (Array.isArray(entries) ? entries : [entries])
        .map((item: Record<string, any>) => mapMediumEntry(item))
        .filter(
          (item: NormalizedContent | undefined): item is NormalizedContent =>
            Boolean(item),
        );
    });
  return deduplicateByCanonicalUrl(items);
}

async function fetchMediumXml(initialUrl: URL): Promise<string> {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.protocol !== "https:" || !/(^|\.)medium\.com$/i.test(url.hostname))
      throw new Error("Redirecionamento de RSS para host não permitido.");
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new Error("Redirecionamento de RSS inválido ou excessivo.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Medium RSS: HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_MEDIUM_FEED_BYTES
    )
      throw new Error("Resposta RSS do Medium excede 2 MiB.");
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MEDIUM_FEED_BYTES) {
        await reader.cancel();
        throw new Error("Resposta RSS do Medium excede 2 MiB.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  throw new Error("Redirecionamento de RSS inválido ou excessivo.");
}

export { deduplicateByCanonicalUrl } from "../core/content";
