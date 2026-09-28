import { XMLParser } from "fast-xml-parser";
import {
  normalizeContent,
  deduplicateByCanonicalUrl,
  type ContentInput,
  type ContentSource,
  type NormalizedContent,
} from "../../core/content-discovery/content";
import { validateFeedUrl } from "../../core/content-discovery/feed-url";
import { limits } from "./limits";
import {
  defaultPublicNetworkDeps,
  requestPublic,
  resolvePublicAddress,
  type PublicNetworkDeps,
} from "../security/public-network";

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

const RATING_TOPIC_STOP_WORDS = new Set([
  ...EXAMPLE_STOP_WORDS,
  "analysis",
  "analytics",
  "article",
  "articles",
  "best",
  "data",
  "intro",
  "introduction",
  "rated",
  "research",
  "study",
  "useful",
  "review",
  "reviews",
  "overview",
  "analisar",
  "analise",
  "artigo",
  "artigos",
  "com",
  "como",
  "para",
  "por",
  "sobre",
]);

/** A single article can affect its own ranking; retrieval changes need repeated ratings. */
export function repeatedRatingTopics(titles: string[]): string[] {
  const minimumDistinctArticles = 3;
  const occurrences = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  const uniqueTitles = [
    ...new Set(titles.map((title) => title.trim()).filter(Boolean)),
  ];

  uniqueTitles.forEach((title, titleIndex) => {
    const terms = new Set(
      title
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .match(/[a-z][a-z0-9+#-]{2,}/g) ?? [],
    );
    for (const term of terms) {
      if (RATING_TOPIC_STOP_WORDS.has(term)) continue;
      occurrences.set(term, (occurrences.get(term) ?? 0) + 1);
      if (!firstSeen.has(term)) firstSeen.set(term, titleIndex);
    }
  });

  return [...occurrences]
    .filter(([, count]) => count >= minimumDistinctArticles)
    .sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount ||
        firstSeen.get(left)! - firstSeen.get(right)! ||
        left.localeCompare(right),
    )
    .slice(0, limits.examples.maxRatedPerPolarity)
    .map(([term]) => term);
}

/** Adds repeated rating topics and imported archive signals to retrieval examples. */
export function withBehavioralExamples(
  profile: ConfirmedInterestProfile,
  ratedUsefulTopics: string[],
  ratedNotUsefulTopics: string[],
  archivedTitles: string[],
): ConfirmedInterestProfile {
  const rated = ratedUsefulTopics
    .slice(0, limits.examples.maxRatedPerPolarity)
    .map((title) => ({ polarity: "positive" as const, title, excerpt: "" }));
  const ratedAgainst = ratedNotUsefulTopics
    .slice(0, limits.examples.maxRatedPerPolarity)
    .map((title) => ({ polarity: "negative" as const, title, excerpt: "" }));
  const archived = archivedTitles.map((title) => ({
    polarity: "positive" as const,
    title,
    excerpt: "",
  }));
  const profilePositive = (profile.examples ?? [])
    .filter((example) => example.polarity === "positive")
    .slice(0, limits.examples.maxProfilePositive);
  const profileNegative = (profile.examples ?? [])
    .filter((example) => example.polarity === "negative")
    .slice(0, limits.examples.maxProfileNegative);
  const examples = [
    ...rated,
    ...ratedAgainst,
    ...archived.slice(0, limits.examples.maxArchivedPriority),
    ...profilePositive,
    ...profileNegative,
    ...archived.slice(limits.examples.maxArchivedPriority),
  ]
    .filter(
      (example, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.title.toLowerCase() === example.title.toLowerCase(),
        ) === index,
    )
    .slice(0, limits.examples.maxTotal);
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
  return [
    ...core.slice(0, limits.tags.maxDevtoProfile - examples.length),
    ...examples,
  ].slice(0, limits.tags.maxDevtoProfile);
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
  return ranked.slice(0, limits.examples.maxSearchTerms);
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
    ...primarySlugs.slice(0, limits.tags.maxMediumSlugs - examples.length),
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
    .slice(0, limits.tags.maxMediumSlugs)
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
  network: PublicNetworkDeps = defaultPublicNetworkDeps,
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
    .slice(
      0,
      isProfile ? limits.tags.maxDevtoProfile : limits.tags.maxDevtoLegacy,
    );
  const responses = await Promise.allSettled(
    tags.map(async (tag) => {
      const url = new URL("https://dev.to/api/articles");
      url.searchParams.set("tag", tag);
      url.searchParams.set("per_page", "30");
      const response = await requestPublic(
        url,
        {
          accept: "application/vnd.forem.api-v1+json",
          timeoutMs: 15000,
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 2,
          allowUrl: (candidate) =>
            candidate.protocol === "https:" &&
            candidate.hostname.toLowerCase() === "dev.to",
        },
        network,
      );
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Dev.to (${tag}): HTTP ${response.status}`);
      const articles: unknown = JSON.parse(
        new TextDecoder().decode(response.body),
      );
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

export type SourceFetchBatch = {
  items: NormalizedContent[];
  attempted: number;
  errors: string[];
};

/** Query-only Dev.to retrieval for the theme search modal. */
export async function fetchDevtoForTheme(
  query: string,
  signal?: AbortSignal,
  network: PublicNetworkDeps = defaultPublicNetworkDeps,
): Promise<SourceFetchBatch> {
  const normalized = query.trim().toLowerCase();
  const aliases: Record<string, string[]> = {
    "artificial intelligence": ["ai", "machinelearning"],
    "data engineering": ["dataengineering"],
    "microsoft fabric": ["microsoftfabric", "fabric"],
    "large language models": ["llm", "ai"],
    llms: ["llm", "ai"],
    "ai agents": ["ai", "agents"],
  };
  const tags = [
    ...new Set(
      (aliases[normalized] ?? [normalized.replace(/[^a-z0-9]/g, "")])
        .filter((tag) => tag.length >= 2 && tag.length <= 30)
        .slice(0, limits.themeResearch.maxDevtoTags),
    ),
  ];
  if (!tags.length)
    return {
      items: [],
      attempted: 0,
      errors: ["O tema não pode ser convertido em uma tag do Dev.to."],
    };
  const results = await Promise.allSettled(
    tags.map(async (tag) => {
      const url = new URL("https://dev.to/api/articles");
      url.searchParams.set("tag", tag);
      url.searchParams.set("per_page", "30");
      const response = await requestPublic(
        url,
        {
          accept: "application/vnd.forem.api-v1+json",
          signal,
          timeoutMs: 15000,
          maxBytes: 2 * 1024 * 1024,
          maxRedirects: 2,
          allowUrl: (candidate) =>
            candidate.protocol === "https:" &&
            candidate.hostname.toLowerCase() === "dev.to",
        },
        network,
      );
      if (response.status < 200 || response.status >= 300)
        throw new Error(`Dev.to (${tag}): HTTP ${response.status}`);
      const payload: unknown = JSON.parse(
        new TextDecoder().decode(response.body),
      );
      if (!Array.isArray(payload))
        throw new Error("Dev.to retornou uma resposta inválida.");
      return (payload as Record<string, unknown>[])
        .map(mapDevtoArticle)
        .filter((item): item is NormalizedContent => Boolean(item));
    }),
  );
  return {
    items: deduplicateByCanonicalUrl(
      results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    ),
    attempted: tags.length,
    errors: results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    ),
  };
}

/** Refresh only the user's configured Medium feeds; no generated topic feeds. */
export async function fetchConfiguredMediumForTheme(
  feeds: string[],
  signal?: AbortSignal,
): Promise<SourceFetchBatch> {
  if (!feeds.length) return { items: [], attempted: 0, errors: [] };
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const url = new URL(validateFeedUrl(feed));
      /* eslint-disable @typescript-eslint/no-explicit-any -- XML parser output is dynamically shaped and validated by field checks below. */
      const parsed = parser.parse(await fetchMediumXml(url, signal)) as Record<
        string,
        any
      >;
      const channel = parsed.rss?.channel ?? parsed.feed;
      const entries = channel?.item ?? channel?.entry ?? [];
      return (Array.isArray(entries) ? entries : [entries])
        .map((item: Record<string, any>) => mapMediumEntry(item))
        /* eslint-enable @typescript-eslint/no-explicit-any */
        .filter(
          (item: NormalizedContent | undefined): item is NormalizedContent =>
            Boolean(item),
        );
    }),
  );
  return {
    items: deduplicateByCanonicalUrl(
      results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    ),
    attempted: feeds.length,
    errors: results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : [],
    ),
  };
}

function sourceForUrl(url: string): "medium" | "rss" {
  return /(^|\.)medium\.com$/i.test(new URL(url).hostname) ? "medium" : "rss";
}

function mapMediumEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw fast-xml-parser output has no fixed shape; validated defensively below
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
    const source: ContentSource = sourceForUrl(url);
    const author =
      item["dc:creator"] ?? item.author?.name ?? item.author ?? "Medium author";
    const description = cleanText(
      item.description ?? item.summary ?? item.content,
    );
    const body = cleanText(item["content:encoded"] ?? item.content ?? "");
    const input: ContentInput = {
      id: `${source}:${url}`,
      title: cleanText(item.title),
      url,
      sourceOccurrence: { source, externalId: url, originalUrl: url },
      author: cleanText(author),
      publishedAt: String(
        item.pubDate ??
          item.published ??
          item.updated ??
          new Date().toISOString(),
      ),
      description: (description || body).slice(
        0,
        limits.normalizedContent.maxDescriptionChars,
      ),
      tags: [item.category].flat().filter(Boolean).map(cleanText),
      excerpt: body.slice(0, limits.normalizedContent.maxExcerptChars),
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
  network: PublicNetworkDeps = defaultPublicNetworkDeps,
): Promise<NormalizedContent[]> {
  const requestedFeeds = mediumFeedsFromProfile(
    feeds,
    confirmedProfile(profile),
  );
  const responses = await Promise.allSettled(
    requestedFeeds.map(async (feed) => {
      const url = new URL(validateFeedUrl(feed));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw fast-xml-parser output has no fixed shape; validated defensively below
      return parser.parse(await fetchMediumXml(url, undefined, network)) as Record<string, any>;
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
      return (
        (Array.isArray(entries) ? entries : [entries])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw fast-xml-parser output has no fixed shape; validated defensively below
          .map((item: Record<string, any>) => mapMediumEntry(item))
          .filter(
            (item: NormalizedContent | undefined): item is NormalizedContent =>
              Boolean(item),
          )
      );
    });
  return deduplicateByCanonicalUrl(items);
}

async function fetchMediumXml(
  initialUrl: URL,
  signal?: AbortSignal,
  network: PublicNetworkDeps = defaultPublicNetworkDeps,
): Promise<string> {
  let url = new URL(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    try {
      url = new URL(validateFeedUrl(url.toString()));
    } catch {
      throw new Error("Redirecionamento de RSS para host não permitido.");
    }
    const timeout = AbortSignal.timeout(15000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const address = await resolvePublicAddress(url, network);
    const response = await network.transport(
      url,
      address,
      requestSignal,
      "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*;q=0.5",
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      response.abort();
      if (!location || redirects === 3)
        throw new Error("Redirecionamento de RSS inválido ou excessivo.");
      url = new URL(Array.isArray(location) ? location[0] : location, url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      response.abort();
      throw new Error(`Feed RSS: HTTP ${response.status}`);
    }
    const rawLength = response.headers["content-length"];
    const declaredLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_MEDIUM_FEED_BYTES
    ) {
      response.abort();
      throw new Error("Resposta do feed RSS excede 2 MiB.");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const value of response.body) {
      bytes += value.byteLength;
      if (bytes > MAX_MEDIUM_FEED_BYTES) {
        response.abort();
        throw new Error("Resposta do feed RSS excede 2 MiB.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Redirecionamento de RSS inválido ou excessivo.");
}
export { deduplicateByCanonicalUrl } from "../../core/content-discovery/content";
