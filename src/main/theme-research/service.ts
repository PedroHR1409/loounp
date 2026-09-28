import { randomBytes } from "node:crypto";
import {
  parseGeneratedThemeBriefing,
  parseThemeSearchInput,
  rankThemeCandidates,
  themeResearchLimits,
  type SavedThemeIdea,
  type ThemeArticleCard,
  type ThemeBriefing,
  type ThemeSearchInput,
  type ThemeSearchEvent,
  type ThemeSearchStatus,
  type ThemeSourceStatus,
} from "../../core/theme-research/contracts";
import { deduplicateByCanonicalUrl, type NormalizedContent } from "../../core/content-discovery/content";
import type { SourceFetchBatch } from "../discovery/sources";
import type { ProjectContextStore } from "../project-context/store";

export type ThemeResearchDeps = {
  store: ProjectContextStore;
  fetchDevto: (query: string, signal: AbortSignal) => Promise<SourceFetchBatch>;
  fetchMedium: (feeds: string[], signal: AbortSignal) => Promise<SourceFetchBatch>;
  configuredFeeds: () => string[];
  listCatalog: () => NormalizedContent[];
  listPersistedContent: () => NormalizedContent[];
  upsertContent: (items: NormalizedContent[]) => Promise<void>;
  generate: (query: string, articles: ThemeArticleCard[], signal: AbortSignal) => Promise<unknown>;
  notify?: (event: ThemeSearchEvent) => void;
  now: () => Date;
};

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
const card = (item: NormalizedContent): ThemeArticleCard => ({
  id: item.id,
  title: item.title,
  url: item.canonicalUrl,
  source: item.sourceOccurrences[0]?.source ?? "unknown",
  author: item.author ?? undefined,
  publishedAt: item.publishedAt ?? undefined,
  description: item.description ?? undefined,
  excerpt: item.excerpt ?? undefined,
  tags: item.tags,
});

export class ThemeResearchService {
  private active: { searchId: string; controller: AbortController } | null = null;
  private briefings = new Map<string, ThemeBriefing>();

  constructor(private readonly deps: ThemeResearchDeps) {}

  start(raw: unknown): { searchId: string } {
    const input: ThemeSearchInput = parseThemeSearchInput(raw);
    if (input.projectId && !this.deps.store.get("projects", input.projectId))
      throw new Error("O projeto selecionado não está catalogado.");
    if (this.active) this.cancel({ searchId: this.active.searchId });
    const searchId = id("search");
    const controller = new AbortController();
    this.active = { searchId, controller };
    this.setState(searchId, "fetching");
    void this.executeSearch(input, searchId, controller);
    return { searchId };
  }

  private emit(event: ThemeSearchEvent) {
    this.deps.notify?.(event);
  }

  private setState(searchId: string, status: ThemeSearchStatus, message?: string) {
    this.emit({ type: "state", searchId, status, ...(message ? { message } : {}) });
  }

  private async executeSearch(
    input: ThemeSearchInput,
    searchId: string,
    controller: AbortController,
  ) {
    const signal = controller.signal;
    const feedList = this.deps.configuredFeeds();
    const fetchSource = async (
      source: "devto" | "medium",
      total: number,
      work: () => Promise<SourceFetchBatch>,
    ): Promise<SourceFetchBatch> => {
      try {
        const batch = await work();
        const label = source === "devto" ? "Dev.to" : "RSS";
        this.emit({
          type: "progress",
          searchId,
          source,
          completed: total,
          total,
          message: `${label}: ${batch.items.length} artigos encontrados`,
        });
        return batch;
      } catch (error) {
        if (signal.aborted) throw error;
        const batch: SourceFetchBatch = {
          items: [],
          attempted: total,
          errors: [String(error)],
        };
        const label = source === "devto" ? "Dev.to" : "RSS";
        this.emit({
          type: "progress",
          searchId,
          source,
          completed: total,
          total,
          message: `${label}: falha na busca`,
        });
        return batch;
      }
    };

    try {
      const [devto, medium] = await Promise.all([
        fetchSource("devto", 1, () => this.deps.fetchDevto(input.query, signal)),
        fetchSource("medium", feedList.length, () =>
          this.deps.fetchMedium(feedList, signal),
        ),
      ]);
      if (signal.aborted) throw new Error("Pesquisa cancelada.");

      const catalog = this.deps.listCatalog();
      const persisted = this.deps.listPersistedContent();
      this.emit({
        type: "progress",
        searchId,
        source: "catalog",
        completed: catalog.length,
        total: catalog.length,
        message: `Catálogo: ${catalog.length} artigos ativos`,
      });
      const remote = deduplicateByCanonicalUrl([...devto.items, ...medium.items]);
      const activeUrls = new Set(catalog.map((item) => item.canonicalUrl));
      const persistedUrls = new Set(persisted.map((item) => item.canonicalUrl));
      const visibleRemote = remote.filter(
        (item) => !persistedUrls.has(item.canonicalUrl) || activeUrls.has(item.canonicalUrl),
      );
      const merged = deduplicateByCanonicalUrl([...catalog, ...visibleRemote]);
      const candidates = rankThemeCandidates(
        input.query,
        merged,
        themeResearchLimits.maxCandidates,
      );
      const statuses = {
        devto: sourceStatus(devto, 1),
        medium: sourceStatus(medium, feedList.length),
        catalog: { state: "ok" as const, fetched: catalog.length },
      };
      await this.deps.upsertContent(remote);
      if (signal.aborted) throw new Error("Pesquisa cancelada.");

      let groups: ThemeBriefing["groups"] = [];
      if (candidates.length) {
        this.setState(searchId, "synthesizing");
        const articles = candidates.map(({ content }) => card(content));
        this.emit({
          type: "progress",
          searchId,
          source: "model",
          completed: 0,
          total: 1,
          message: "Preparando o briefing dos artigos",
        });
        const generated = await this.deps.generate(input.query, articles, signal);
        if (signal.aborted) throw new Error("Pesquisa cancelada.");
        groups = parseGeneratedThemeBriefing(
          generated,
          new Set(articles.map((article) => article.id)),
        ).groups;
        this.emit({
          type: "progress",
          searchId,
          source: "model",
          completed: 1,
          total: 1,
          message: "Briefing pronto",
        });
      }
      const anyRemoteFailed =
        statuses.devto.state === "failed" ||
        statuses.medium.state === "failed" ||
        Boolean(devto.errors.length || medium.errors.length);
      const allFailed =
        statuses.devto.state === "failed" &&
        (statuses.medium.state === "failed" ||
          statuses.medium.state === "not_configured");
      const status = !candidates.length
        ? allFailed && !catalog.length
          ? "failed"
          : "empty"
        : anyRemoteFailed
          ? "partial"
          : "complete";
      const briefing: ThemeBriefing = {
        searchId,
        query: input.query,
        status,
        sources: statuses,
        articles: candidates.map(({ content }) => card(content)),
        groups,
        notices: [
          ...devto.errors.map((message) => `Dev.to: ${message}`),
          ...medium.errors.map((message) => `Medium: ${message}`),
        ],
        projectId: input.mode === "associate" ? input.projectId ?? null : null,
        contextMode: input.mode ?? "none",
        consentPackageId: null,
        provider: null,
        model: null,
        createdAt: this.deps.now().toISOString(),
      };
      this.briefings.set(searchId, briefing);
      while (this.briefings.size > 20)
        this.briefings.delete(this.briefings.keys().next().value!);
      this.setState(searchId, status);
      this.emit({ type: "result", searchId, briefing });
    } catch (error) {
      if (signal.aborted) {
        if (this.active?.searchId === searchId)
          this.setState(searchId, "canceled");
      } else {
        const message = String((error as Error).message ?? error);
        this.setState(searchId, "failed", message);
        this.emit({ type: "error", searchId, message });
      }
    } finally {
      if (this.active?.searchId === searchId) this.active = null;
    }
  }

  cancel(raw: unknown) {
    const searchId =
      typeof raw === "object" && raw !== null
        ? (raw as { searchId?: unknown }).searchId
        : undefined;
    if (typeof searchId !== "string" || this.active?.searchId !== searchId)
      return false;
    const active = this.active;
    this.active = null;
    active.controller.abort();
    this.setState(searchId, "canceled");
    return true;
  }
  async saveIdea(raw: unknown): Promise<SavedThemeIdea> {
    if (!isRecord(raw) || typeof raw.searchId !== "string" || typeof raw.ideaId !== "string" || Object.keys(raw).some((key) => !["searchId", "ideaId", "projectId"].includes(key)))
      throw new Error("Ideia inválida.");
    if (raw.projectId !== undefined && (typeof raw.projectId !== "string" || !this.deps.store.get("projects", raw.projectId)))
      throw new Error("O projeto selecionado não está catalogado.");
    const briefing = this.briefings.get(raw.searchId);
    if (!briefing) throw new Error("A pesquisa expirou; faça uma nova busca.");
    const group = briefing.groups.find((item) => item.ideas.some((idea) => idea.id === raw.ideaId));
    const idea = group?.ideas.find((item) => item.id === raw.ideaId);
    if (!group || !idea) throw new Error("A ideia não pertence a esta pesquisa.");
    const associatedProject = (raw.projectId as string | undefined) ?? briefing.projectId;
    const existing = this.deps.store.list("saved_theme_ideas").find((saved) =>
      saved.searchId === briefing.searchId && saved.title === idea.title && saved.projectId === associatedProject,
    );
    if (existing) return existing;
    const saved: SavedThemeIdea = {
      id: id("theme"), searchId: briefing.searchId, query: briefing.query,
      groupId: group.id, groupLabel: group.label, title: idea.title,
      summary: idea.summary, application: idea.application,
      supportingArticleIds: idea.supportingArticleIds,
      projectId: associatedProject,
      contextMode: associatedProject ? "associate" : briefing.contextMode,
      consentPackageId: null, provider: null, model: null, derivedFromIdeaId: null,
      createdAt: this.deps.now().toISOString(),
    };
    await this.deps.store.mutate((tx) => tx.put("saved_theme_ideas", saved, saved.projectId, saved.createdAt));
    return saved;
  }

  listSaved(raw?: unknown): SavedThemeIdea[] {
    const projectId = isRecord(raw) && typeof raw.projectId === "string" ? raw.projectId : undefined;
    return this.deps.store.list("saved_theme_ideas").filter((idea) => projectId === undefined || idea.projectId === projectId);
  }

  async deleteSaved(raw: unknown): Promise<void> {
    if (!isRecord(raw) || typeof raw.id !== "string") throw new Error("Ideia inválida.");
    await this.deps.store.mutate((tx) => tx.delete("saved_theme_ideas", raw.id as string));
  }

  getStatus(raw: unknown): ThemeBriefing | null {
    if (!isRecord(raw) || typeof raw.searchId !== "string") return null;
    return this.briefings.get(raw.searchId) ?? null;
  }
}

function sourceStatus(batch: SourceFetchBatch, configured: number): ThemeSourceStatus {
  if (configured === 0) return { state: "not_configured", fetched: 0 };
  return batch.errors.length >= batch.attempted && batch.attempted > 0
    ? { state: "failed", fetched: batch.items.length, message: batch.errors.join("; ") }
    : { state: "ok", fetched: batch.items.length, ...(batch.errors.length ? { message: batch.errors.join("; ") } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
