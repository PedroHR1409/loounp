import type { NormalizedContent } from "../content-discovery/content";

export type ThemeContextMode = "none" | "associate" | "contextualize";
export type ThemeSearchMode = Exclude<ThemeContextMode, "contextualize">;
export type ThemeSearchStatus =
  | "created"
  | "fetching"
  | "awaiting_context_consent"
  | "synthesizing"
  | "complete"
  | "partial"
  | "empty"
  | "failed"
  | "canceled";

export type ThemeSearchInput = {
  query: string;
  projectId?: string;
  mode?: ThemeSearchMode;
};

export type ThemeSourceStatus = {
  state: "ok" | "failed" | "not_configured";
  fetched: number;
  message?: string;
};

export type ThemeArticleCard = {
  id: string;
  title: string;
  url: string;
  source: string;
  author?: string;
  publishedAt?: string;
  description?: string;
  excerpt?: string;
  tags: string[];
};

export type ThemeIdeaDraft = {
  id: string;
  title: string;
  summary: string;
  application: string;
  supportingArticleIds: string[];
};

export type ThemeGroupDraft = {
  id: string;
  label: string;
  summary: string;
  articleIds: string[];
  ideas: ThemeIdeaDraft[];
};

export type ThemeBriefing = {
  searchId: string;
  query: string;
  status: "complete" | "partial" | "empty" | "failed";
  sources: {
    devto: ThemeSourceStatus;
    medium: ThemeSourceStatus;
    catalog: ThemeSourceStatus;
  };
  articles: ThemeArticleCard[];
  groups: ThemeGroupDraft[];
  notices: string[];
  projectId: string | null;
  contextMode: ThemeContextMode;
  consentPackageId: string | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
};

export type ThemeSearchEvent =
  | {
      type: "state";
      searchId: string;
      status: ThemeSearchStatus;
      message?: string;
    }
  | {
      type: "progress";
      searchId: string;
      source: "devto" | "medium" | "catalog" | "model";
      completed: number;
      total: number;
      message: string;
    }
  | { type: "result"; searchId: string; briefing: ThemeBriefing }
  | { type: "error"; searchId: string; message: string };

export type SavedThemeIdea = {
  id: string;
  searchId: string;
  query: string;
  groupId: string;
  groupLabel: string;
  title: string;
  summary: string;
  application: string;
  supportingArticleIds: string[];
  projectId: string | null;
  contextMode: ThemeContextMode;
  consentPackageId: string | null;
  provider: string | null;
  model: string | null;
  derivedFromIdeaId: string | null;
  createdAt: string;
};

export type GeneratedThemeBriefing = {
  groups: ThemeGroupDraft[];
};

export type RankedThemeCandidate = {
  content: NormalizedContent;
  score: number;
};

export class ThemeResearchInputError extends Error {}

export const themeResearchLimits = {
  minQueryChars: 2,
  maxQueryChars: 120,
  maxDevtoTags: 3,
  maxCandidates: 60,
  maxGroups: 6,
  maxArticlesPerGroup: 5,
  maxIdeasPerGroup: 3,
  maxArticleTextChars: 2000,
  maxGroupLabelChars: 100,
  maxGroupSummaryChars: 600,
  maxIdeaTitleChars: 140,
  maxIdeaSummaryChars: 700,
  maxIdeaApplicationChars: 1200,
} as const;
const MAX_ID_CHARS = 200;

export function parseThemeSearchInput(input: unknown): ThemeSearchInput {
  if (!isRecord(input)) throw new ThemeResearchInputError("Entrada inválida.");
  const query = normalizeThemeQuery(input.query);
  const mode = input.mode ?? "none";
  if (mode !== "none" && mode !== "associate")
    throw new ThemeResearchInputError("Modo de pesquisa inválido.");
  const projectId = input.projectId;
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" ||
      !projectId.trim() ||
      projectId.length > MAX_ID_CHARS)
  )
    throw new ThemeResearchInputError("Projeto inválido.");
  if (mode === "none" && projectId)
    throw new ThemeResearchInputError(
      "Escolha associar ou contextualizar para incluir um projeto.",
    );
  for (const key of Object.keys(input))
    if (!["query", "projectId", "mode"].includes(key))
      throw new ThemeResearchInputError(`Campo não permitido: ${key}.`);
  return {
    query,
    ...(projectId ? { projectId: projectId.trim() } : {}),
    mode,
  };
}

export function normalizeThemeQuery(value: unknown): string {
  if (typeof value !== "string")
    throw new ThemeResearchInputError("Informe um tema para pesquisar.");
  const query = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (
    query.length < themeResearchLimits.minQueryChars ||
    query.length > themeResearchLimits.maxQueryChars
  )
    throw new ThemeResearchInputError(
      `O tema deve ter de ${themeResearchLimits.minQueryChars} a ${themeResearchLimits.maxQueryChars} caracteres.`,
    );
  return query;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim();
}

/** Deterministic lexical shortlist. A candidate must contain the full phrase or a query token. */
export function rankThemeCandidates(
  query: string,
  contents: NormalizedContent[],
  limit: number,
): RankedThemeCandidate[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const ranked = contents.flatMap((content) => {
    const title = normalizeSearchText(content.title);
    const tags = normalizeSearchText(content.tags.join(" "));
    const description = normalizeSearchText(content.description ?? "");
    const excerpt = normalizeSearchText(content.excerpt ?? "");
    const body = `${title} ${tags} ${description} ${excerpt}`;
    const phraseMatch = body.includes(normalizedQuery);
    const matched = queryTokens.filter((token) => body.includes(token));
    if (!phraseMatch && matched.length === 0) return [];
    const score =
      (phraseMatch ? 10 : 0) +
      matched.length * 2 +
      (title.includes(normalizedQuery) ? 8 : 0) +
      (tags.includes(normalizedQuery) ? 7 : 0) +
      (description.includes(normalizedQuery) ? 3 : 0) +
      (excerpt.includes(normalizedQuery) ? 2 : 0);
    return [{ content, score }];
  });
  return ranked
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aDate = Date.parse(a.content.publishedAt ?? "") || 0;
      const bDate = Date.parse(b.content.publishedAt ?? "") || 0;
      if (bDate !== aDate) return bDate - aDate;
      return a.content.canonicalUrl.localeCompare(b.content.canonicalUrl);
    })
    .slice(0, Math.max(0, limit));
}

/** Resolves structured model output only against candidate IDs; model-supplied URLs are never accepted. */
export function parseGeneratedThemeBriefing(
  input: unknown,
  allowedArticleIds: ReadonlySet<string>,
): GeneratedThemeBriefing {
  if (!isRecord(input) || !Array.isArray(input.groups))
    throw new ThemeResearchInputError("A resposta do modelo não tem grupos.");
  const groups: ThemeGroupDraft[] = [];
  const assignedArticleIds = new Set<string>();
  for (const rawGroup of input.groups.slice(0, themeResearchLimits.maxGroups)) {
    if (
      !isRecord(rawGroup) ||
      typeof rawGroup.id !== "string" ||
      typeof rawGroup.label !== "string" ||
      typeof rawGroup.summary !== "string" ||
      !Array.isArray(rawGroup.articleIds) ||
      !Array.isArray(rawGroup.ideas)
    )
      continue;
    const articleIds = uniqueIds(rawGroup.articleIds)
      .filter((id) => allowedArticleIds.has(id) && !assignedArticleIds.has(id))
      .slice(0, themeResearchLimits.maxArticlesPerGroup);
    if (!articleIds.length) continue;
    const ideas: ThemeIdeaDraft[] = [];
    for (const rawIdea of rawGroup.ideas.slice(
      0,
      themeResearchLimits.maxIdeasPerGroup,
    )) {
      if (
        !isRecord(rawIdea) ||
        typeof rawIdea.id !== "string" ||
        typeof rawIdea.title !== "string" ||
        typeof rawIdea.summary !== "string" ||
        typeof rawIdea.application !== "string" ||
        !Array.isArray(rawIdea.supportingArticleIds)
      )
        continue;
      const supportingArticleIds = uniqueIds(rawIdea.supportingArticleIds)
        .filter((id) => articleIds.includes(id))
        .slice(0, themeResearchLimits.maxArticlesPerGroup);
      const title = boundedText(
        rawIdea.title,
        themeResearchLimits.maxIdeaTitleChars,
      );
      const summary = boundedText(
        rawIdea.summary,
        themeResearchLimits.maxIdeaSummaryChars,
      );
      const application = boundedText(
        rawIdea.application,
        themeResearchLimits.maxIdeaApplicationChars,
      );
      if (!supportingArticleIds.length || !title || !summary || !application)
        continue;
      ideas.push({
        id: boundedText(rawIdea.id, 100) || `idea-${ideas.length + 1}`,
        title,
        summary,
        application,
        supportingArticleIds,
      });
    }
    const label = boundedText(
      rawGroup.label,
      themeResearchLimits.maxGroupLabelChars,
    );
    const summary = boundedText(
      rawGroup.summary,
      themeResearchLimits.maxGroupSummaryChars,
    );
    if (!label || !summary) continue;
    articleIds.forEach((id) => assignedArticleIds.add(id));
    groups.push({
      id: boundedText(rawGroup.id, 100) || `group-${groups.length + 1}`,
      label,
      summary,
      articleIds,
      ideas,
    });
  }
  if (!groups.length)
    throw new ThemeResearchInputError(
      "O modelo não retornou grupos com artigos válidos.",
    );
  return { groups };
}

function uniqueIds(values: unknown[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_ID_CHARS &&
      !ids.includes(value)
    )
      ids.push(value);
  }
  return ids;
}

function boundedText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
