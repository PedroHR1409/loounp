import { createHash, randomBytes } from "node:crypto";
import {
  buildGenerationPayload,
  ContractError,
  estimateTokens,
  limits,
  parseAuthorizeInput,
  parseModelJson,
  parseRateInput,
  parseRemoveItemInput,
  parseSetPurposeInput,
  parseStartInput,
  strictObject,
  is,
  terminalStates,
  transition,
  validateRecommendation,
  CONTRACT_VERSION,
  type ArticleOrigin,
  type ArticleSnapshot,
  type Consent,
  type ContextPackage,
  type Evaluation,
  type Evidence,
  type GenerationPayload,
  type IdeaEvent,
  type IdeaOutcome,
  type IgnoredSource,
  type ModelConfig,
  type Operation,
  type OperationState,
  type PackageItem,
  type Purpose,
  type Recommendation,
} from "../core/project-ideas";
import {
  activeMemories,
  answerKnowledge,
  knowledgeFor,
  termKey,
  confirm,
  correct,
  discard,
  forget,
  memoryKinds,
  memoryView,
  propose,
  revoke,
  type MemoryKind,
  type MemoryLedger,
} from "../core/personal-memory";
import type { ProjectContextStore, AuditEntry } from "./project-context-store";
import {
  ingestCatalog,
  retrieveEvidence,
  type CatalogCoverage,
} from "./project-context-retrieval";
import type { IsolationStatus, WorkerResult } from "./project-context-sandbox";
import {
  ArticleFetchError,
  snapshotFromUserText,
} from "./project-article-reader";
import OpenAI, { APIConnectionError, APIError } from "openai";

export type GatewayResult = {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};
export type Gateway = {
  provider: string;
  call: (
    payload: GenerationPayload,
    signal: AbortSignal,
  ) => Promise<GatewayResult>;
  isTransient: (error: unknown) => boolean;
};
export type IsolationPort = {
  status: () => Promise<IsolationStatus>;
  run: (
    op: "catalog" | "revalidate",
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<WorkerResult>;
  cancel: () => Promise<void>;
  policySha256: string;
};
export type ProjectIdeasDeps = {
  store: ProjectContextStore;
  readArticle: (
    url: string,
    origin: ArticleOrigin,
    signal: AbortSignal,
    fallbackTitle: string,
  ) => Promise<ArticleSnapshot>;
  findContent: (
    contentId: string,
  ) => { title: string; url: string; description: string } | null;
  interestStatements: () => Array<{
    kind: MemoryKind;
    text: string;
    reference: string;
  }>;
  isolation: IsolationPort;
  gateway: () => Gateway | null;
  now: () => Date;
  notify?: (event: IdeaEvent) => void;
};

type Prepared = {
  operation: Operation;
  pkg: ContextPackage;
  consent: Consent;
  gateway: Gateway;
};

export class ConsentError extends Error {}

const id = (prefix: string) =>
  `${prefix}_${randomBytes(12).toString("base64url")}`;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const itemId = (key: string) => `itm_${sha256(key).slice(0, 20)}`;

export class ProjectIdeasService {
  private controllers = new Map<string, AbortController>();
  private jobs = new Map<string, Promise<void>>();

  constructor(private readonly deps: ProjectIdeasDeps) {}

  private get store() {
    return this.deps.store;
  }

  async init(): Promise<void> {
    const at = this.deps.now().toISOString();
    await this.store.mutate((tx) => {
      for (const operation of this.store.list("operations")) {
        if (!terminalStates.has(operation.state))
          tx.put(
            "operations",
            {
              ...operation,
              state: "interrupted",
              error:
                "O aplicativo foi fechado durante a operação; nada foi enviado automaticamente.",
              updatedAt: at,
            },
            null,
            operation.createdAt,
          );
      }
      for (const consent of this.store.list("consents"))
        if (!consent.revoked)
          tx.put(
            "consents",
            { ...consent, revoked: true },
            consent.packageId,
            consent.confirmedAt,
          );
    });
    await this.store.applyRetention(this.deps.now());
  }

  private activeOperation(): Operation | null {
    return (
      this.store
        .list("operations")
        .find((operation) => !terminalStates.has(operation.state)) ?? null
    );
  }

  private requireOperation(operationId: string): Operation {
    const operation = this.store.get("operations", operationId);
    if (!operation) throw new ContractError("Operação não encontrada.");
    return operation;
  }

  private async setState(
    operation: Operation,
    state: OperationState,
    patch: Partial<Operation> = {},
  ): Promise<Operation> {
    const current = this.requireOperation(operation.id);
    const next: Operation = {
      ...current,
      ...patch,
      state: transition(current.state, state),
      updatedAt: this.deps.now().toISOString(),
    };
    await this.store.mutate((tx) =>
      tx.put("operations", next, null, next.createdAt),
    );
    this.deps.notify?.({
      type: "state",
      operationId: next.id,
      contentId: next.contentId,
      state: next.state,
      contextMode: next.contextMode,
    });
    if (terminalStates.has(next.state)) this.emitFinished(next);
    return next;
  }

  private emitFinished(operation: Operation) {
    const recommendation = this.store.list("recommendations", operation.id)[0];
    const outcome: IdeaOutcome =
      operation.state === "completed" && recommendation
        ? (recommendation.status as IdeaOutcome)
        : operation.state === "canceled"
          ? "canceled"
          : operation.state === "interrupted"
            ? "interrupted"
            : "failed";
    this.deps.notify?.({
      type: "finished",
      operationId: operation.id,
      contentId: operation.contentId,
      contextMode: operation.contextMode,
      comparisonOf: operation.comparisonOf,
      articleTitle: operation.article?.title ?? "",
      outcome,
      title: recommendation?.title ?? "",
      error: operation.error,
    });
  }

  settled(operationId: string): Promise<void> {
    return this.jobs.get(operationId) ?? Promise.resolve();
  }

  private audit(
    event: AuditEntry["event"],
    operationId: string,
    payloadSha256: string | null,
    itemIds: string[],
  ) {
    return this.store.mutate((tx) =>
      tx.put(
        "audit",
        {
          id: id("aud"),
          operationId,
          event,
          payloadSha256,
          itemIds,
          at: this.deps.now().toISOString(),
        },
        operationId,
        this.deps.now().toISOString(),
      ),
    );
  }

  async start(input: unknown) {
    const parsed = parseStartInput(input);
    const active = this.activeOperation();
    if (active) {
      const pending =
        active.state === "awaiting_consent" ||
        active.state === "awaiting_article_text";
      if (!pending) return this.view(active.id, true);
      if (
        active.contextMode === "full" &&
        active.contentId !== null &&
        active.contentId === parsed.contentId &&
        !parsed.text &&
        !parsed.purpose
      )
        return this.view(active.id);
      await this.invalidateConsents(active.id, "Substituída.");
      await this.setState(active, "canceled", {
        error: "Substituída por outra exploração antes de qualquer envio.",
      });
    }
    const purpose = parsed.purpose ?? this.store.lastPurpose();
    const at = this.deps.now().toISOString();
    await this.store.mutate((tx) => tx.setConfig("last_purpose", purpose));
    let operation: Operation = {
      id: id("op"),
      state: "created",
      article: null,
      contentId: parsed.contentId ?? null,
      purpose,
      selectedProjectIds: null,
      projectsConsulted: false,
      attempt: 0,
      currentPackageId: null,
      contextMode: "full",
      comparisonOf: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.store.mutate((tx) => tx.put("operations", operation, null, at));
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    try {
      const content = parsed.contentId
        ? this.deps.findContent(parsed.contentId)
        : null;
      if (parsed.contentId && !content)
        throw new ContractError("Artigo do feed não encontrado.");
      const origin: ArticleOrigin = parsed.contentId
        ? { kind: "item", contentId: parsed.contentId, url: content!.url }
        : parsed.url
          ? { kind: "url", url: parsed.url }
          : { kind: "text" };
      if (parsed.text) {
        const article = snapshotFromUserText(
          parsed.text,
          parsed.title ?? content?.title ?? "",
          origin,
          this.deps.now(),
        );
        operation = await this.setState(operation, "awaiting_article_text", {
          article,
        });
        return await this.continueWithArticle(
          operation,
          article,
          controller.signal,
        );
      }
      operation = await this.setState(operation, "acquiring_article");
      let article: ArticleSnapshot;
      try {
        article = await this.deps.readArticle(
          parsed.url ?? content!.url,
          origin,
          controller.signal,
          content?.title ?? "",
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        const reason =
          error instanceof ArticleFetchError
            ? error.message
            : "Não foi possível ler a página.";
        operation = await this.setState(operation, "awaiting_article_text", {
          error: `${reason} Cole o texto do artigo para continuar.`,
        });
        return this.view(operation.id);
      }
      if (article.coverage === "metadata_only") {
        operation = await this.setState(operation, "awaiting_article_text", {
          article,
          error:
            "Apenas título e descrição estavam disponíveis. Cole o texto do artigo para uma recomendação detalhada.",
        });
        return this.view(operation.id);
      }
      return await this.continueWithArticle(
        operation,
        article,
        controller.signal,
      );
    } catch (error) {
      await this.fail(operation.id, error, controller.signal.aborted);
      throw error;
    } finally {
      this.controllers.delete(operation.id);
    }
  }

  async submitText(input: unknown) {
    const parsed = strictObject<{ operationId: string; text: string }>(input, {
      operationId: is.id,
      text: is.text(limits.article.maxTextChars * 2, 200),
    });
    const operation = this.requireOperation(parsed.operationId);
    if (
      operation.state !== "awaiting_article_text" &&
      operation.state !== "awaiting_consent"
    )
      throw new ContractError("Esta operação não aceita texto agora.");
    if (operation.state === "awaiting_consent")
      await this.invalidateConsents(
        operation.id,
        "Texto do artigo substituído.",
      );
    const origin: ArticleOrigin =
      operation.article?.origin ??
      (operation.contentId
        ? { kind: "item", contentId: operation.contentId }
        : { kind: "text" });
    const article = snapshotFromUserText(
      parsed.text,
      operation.article?.title ?? "",
      origin,
      this.deps.now(),
    );
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    try {
      return await this.continueWithArticle(
        operation,
        article,
        controller.signal,
      );
    } catch (error) {
      await this.fail(operation.id, error, controller.signal.aborted);
      throw error;
    } finally {
      this.controllers.delete(operation.id);
    }
  }

  private async continueWithArticle(
    operation: Operation,
    article: ArticleSnapshot,
    signal: AbortSignal,
  ) {
    await this.store.mutate((tx) =>
      tx.put("articles", article, operation.id, article.capturedAt),
    );
    operation = await this.setState(operation, "retrieving_context", {
      article,
      error: null,
    });
    const pkg = await this.buildPackage(operation, [], null, signal);
    await this.setState(operation, "awaiting_consent", {
      currentPackageId: pkg.id,
      projectsConsulted: pkg.projectsConsulted,
    });
    return this.view(operation.id);
  }

  private async fail(operationId: string, error: unknown, canceled: boolean) {
    const operation = this.store.get("operations", operationId);
    if (!operation || terminalStates.has(operation.state)) return;
    await this.setState(operation, canceled ? "canceled" : "failed", {
      error: canceled
        ? "Operação cancelada."
        : String((error as Error)?.message ?? error),
    });
  }

  private async selectEvidence(
    operation: Operation,
    projectIds: string[] | null,
    signal: AbortSignal,
  ): Promise<{ evidence: Evidence[]; consulted: boolean; notices: string[] }> {
    const status = await this.deps.isolation.status();
    if (status.state !== "ready")
      return {
        evidence: [],
        consulted: false,
        notices: [`Projetos não consultados: ${status.reasons.join(" ")}`],
      };
    const retrieved = await retrieveEvidence(
      this.store,
      { title: operation.article!.title, text: operation.article!.text },
      projectIds ?? undefined,
      {
        graph: this.store.graphExpansionEnabled(),
        ignoredPaths: this.store.ignoredPaths(),
      },
    );
    if (!retrieved.projectsSearched.length)
      return {
        evidence: [],
        consulted: false,
        notices: [
          'Nenhum contexto de projeto indexado. Use "Atualizar contexto dos projetos".',
        ],
      };
    if (!retrieved.evidence.length)
      return {
        evidence: [],
        consulted: true,
        notices: ["Nenhum trecho dos projetos corresponde ao artigo."],
      };
    const versions = new Map(
      retrieved.evidence.map((evidence) => [
        evidence.sourceVersionId,
        this.store.get("source_versions", evidence.sourceVersionId)!,
      ]),
    );
    const byPath = new Map<
      string,
      {
        relativePath: string;
        sha256: string;
        ranges: Array<{ startLine: number; endLine: number }>;
      }
    >();
    for (const evidence of retrieved.evidence) {
      const version = versions.get(evidence.sourceVersionId)!;
      const entry = byPath.get(version.relativePath) ?? {
        relativePath: version.relativePath,
        sha256: version.sha256,
        ranges: [],
      };
      entry.ranges.push({
        startLine: evidence.startLine,
        endLine: evidence.endLine,
      });
      byPath.set(version.relativePath, entry);
    }
    const revalidated = await this.deps.isolation.run(
      "revalidate",
      { files: [...byPath.values()] },
      signal,
    );
    const results = new Map(
      (Array.isArray(revalidated.response.files)
        ? revalidated.response.files
        : []
      ).map((file) => [
        (file as { relativePath: string }).relativePath,
        file as {
          status: string;
          excerpts?: Array<{
            startLine: number;
            endLine: number;
            text: string;
          }>;
        },
      ]),
    );
    const notices: string[] = [];
    const evidence = retrieved.evidence.flatMap((item) => {
      const result = results.get(item.relativePath);
      if (result?.status !== "unchanged") {
        notices.push(
          `${item.relativePath} mudou, foi removido ou excluído desde a indexação e não será citado.`,
        );
        return [];
      }
      const fresh = result.excerpts?.find(
        (excerpt) =>
          excerpt.startLine === item.startLine &&
          excerpt.endLine === item.endLine,
      );
      return fresh ? [{ ...item, excerpt: fresh.text }] : [];
    });
    await this.store.mutate((tx) => {
      for (const item of evidence)
        tx.put("evidence", item, item.projectId, this.deps.now().toISOString());
    });
    return { evidence, consulted: true, notices: [...new Set(notices)] };
  }

  private modelConfig(): ModelConfig {
    return this.store.modelConfig();
  }

  private async buildPackage(
    operation: Operation,
    excludeItemIds: string[],
    projectIds: string[] | null,
    signal: AbortSignal,
  ): Promise<ContextPackage> {
    const article = operation.article!;
    const articleOnly = operation.contextMode === "article_only";
    const { evidence, consulted, notices } = articleOnly
      ? {
          evidence: [],
          consulted: false,
          notices: [
            "Versão sem contexto para comparação (Gate 3): somente o artigo, com o mesmo modelo e as mesmas instruções.",
          ],
        }
      : await this.selectEvidence(operation, projectIds, signal);
    const ledger = this.store.ledger();
    const ignoredMemories = this.store.ignoredMemories();
    const projects = new Map(
      this.store.list("projects").map((project) => [project.id, project]),
    );
    let memoryChars = 0;
    const memories = articleOnly
      ? []
      : activeMemories(ledger)
          .filter((memory) => !ignoredMemories.has(memory.memoryId))
          .slice(0, limits.retrieval.maxMemories)
          .filter(
            (memory) =>
              (memoryChars += memory.text.length) <=
              limits.retrieval.maxMemoryChars,
          );
    const items: PackageItem[] = [
      {
        id: itemId(`article|${article.sha256}`),
        kind: "article",
        label: `Artigo: ${article.title} (${article.coverage})`,
        text: article.text,
      },
      ...memories.map((memory): PackageItem => ({
        id: itemId(`memory|${memory.memoryId}|${memory.revision}`),
        kind: "memory",
        label: `Contexto pessoal (${memory.kind}, ${memory.origin === "interest_profile" ? "declarado no perfil de interesses" : "confirmado"})`,
        text: memory.text,
        memoryId: memory.memoryId,
        memoryRevision: memory.revision,
      })),
      ...evidence.map((item): PackageItem => {
        const version = this.store.get(
          "source_versions",
          item.sourceVersionId,
        )!;
        return {
          id: itemId(`evidence|${item.id}|${version.sha256}`),
          kind: "evidence",
          label: `${projects.get(item.projectId)?.label ?? "projeto"} · ${item.relativePath} L${item.startLine}-${item.endLine}${item.origin === "inferred" ? " (relação inferida pelo grafo)" : ""} · ${item.projectId}`,
          text: item.excerpt,
          sourceVersionId: item.sourceVersionId,
          sha256: version.sha256,
          projectLabel: projects.get(item.projectId)?.label ?? "projeto",
          relativePath: item.relativePath,
          lines: `L${item.startLine}-${item.endLine}`,
        };
      }),
    ];
    if (excludeItemIds.includes(items[0].id))
      throw new ContractError("O artigo não pode ser removido do pacote.");
    const kept = items.filter((item) => !excludeItemIds.includes(item.id));
    const config = this.modelConfig();
    const draft = {
      items: kept,
      purpose: operation.purpose,
      model: config.model,
      articleCoverage: article.coverage,
      projectsConsulted: consulted,
    };
    const payload = buildGenerationPayload(draft);
    const serialized = JSON.stringify(payload);
    const pkg: ContextPackage = {
      id: id("pkg"),
      operationId: operation.id,
      contract: CONTRACT_VERSION,
      articleSha256: article.sha256,
      articleCoverage: article.coverage,
      items: kept,
      memoryGlobalRevision: ledger.globalRevision,
      provider: config.provider,
      model: config.model,
      purpose: operation.purpose,
      payloadSha256: sha256(serialized),
      estimatedTokens: estimateTokens(payload.instructions + payload.input),
      callBudget: limits.ai.maxCalls,
      reviewToken: randomBytes(32).toString("hex"),
      createdAt: this.deps.now().toISOString(),
      projectsConsulted: consulted,
      notices: [...notices, ...article.limitations],
    };
    await this.store.mutate((tx) =>
      tx.put("context_packages", pkg, operation.id, pkg.createdAt),
    );
    return pkg;
  }

  private async derivePackage(
    operation: Operation,
    base: ContextPackage,
    change: { excludeItemIds?: string[]; purpose?: Purpose },
  ): Promise<ContextPackage> {
    if (change.excludeItemIds?.includes(base.items[0].id))
      throw new ContractError("O artigo não pode ser removido do pacote.");
    const items = base.items.filter(
      (item) => !change.excludeItemIds?.includes(item.id),
    );
    const purpose = change.purpose ?? base.purpose;
    const payload = buildGenerationPayload({
      items,
      purpose,
      model: base.model,
      articleCoverage: base.articleCoverage,
      projectsConsulted: base.projectsConsulted,
    });
    const pkg: ContextPackage = {
      ...base,
      id: id("pkg"),
      items,
      purpose,
      payloadSha256: sha256(JSON.stringify(payload)),
      estimatedTokens: estimateTokens(payload.instructions + payload.input),
      reviewToken: randomBytes(32).toString("hex"),
      createdAt: this.deps.now().toISOString(),
    };
    await this.invalidateConsents(operation.id, "Pacote alterado.");
    await this.store.mutate((tx) => {
      tx.put("context_packages", pkg, operation.id, pkg.createdAt);
      tx.put(
        "operations",
        {
          ...operation,
          purpose,
          currentPackageId: pkg.id,
          updatedAt: pkg.createdAt,
        },
        null,
        operation.createdAt,
      );
    });
    return pkg;
  }

  private editablePackage(operationId: string, packageId: string) {
    const operation = this.requireOperation(operationId);
    if (
      operation.state !== "awaiting_consent" ||
      operation.currentPackageId !== packageId
    )
      throw new ConsentError(
        "Este pacote não é mais o vigente; o modal foi atualizado.",
      );
    const pkg = this.store.get("context_packages", packageId);
    if (!pkg) throw new ContractError("Pacote não encontrado.");
    return { operation, pkg };
  }

  async removeItem(input: unknown) {
    const parsed = parseRemoveItemInput(input);
    const { operation, pkg } = this.editablePackage(
      parsed.operationId,
      parsed.packageId,
    );
    const item = pkg.items.find((candidate) => candidate.id === parsed.itemId);
    if (!item) throw new ContractError("Item não está no pacote.");
    if (parsed.scope === "always") {
      const source: IgnoredSource | null =
        item.kind === "evidence" && item.relativePath
          ? {
              id: id("ign"),
              kind: "file",
              relativePath: item.relativePath,
              memoryId: null,
              label: `${item.projectLabel ?? ""} · ${item.relativePath}`,
              createdAt: this.deps.now().toISOString(),
            }
          : item.kind === "memory" && item.memoryId
            ? {
                id: id("ign"),
                kind: "memory",
                relativePath: null,
                memoryId: item.memoryId,
                label: item.text.slice(0, 160),
                createdAt: this.deps.now().toISOString(),
              }
            : null;
      if (!source)
        throw new ContractError(
          "Este item não pode ser ignorado permanentemente.",
        );
      const exists = this.store
        .list("ignored_sources")
        .some(
          (entry) =>
            entry.kind === source.kind &&
            entry.relativePath === source.relativePath &&
            entry.memoryId === source.memoryId,
        );
      if (!exists)
        await this.store.mutate((tx) =>
          tx.put("ignored_sources", source, null, source.createdAt),
        );
    }
    const excludeItemIds =
      parsed.scope === "always" && item.relativePath
        ? pkg.items
            .filter((candidate) => candidate.relativePath === item.relativePath)
            .map((candidate) => candidate.id)
        : [item.id];
    await this.derivePackage(operation, pkg, { excludeItemIds });
    return this.view(operation.id);
  }

  async rebuild(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    let operation = this.requireOperation(parsed.operationId);
    if (operation.state !== "awaiting_consent")
      throw new ContractError("Esta operação não está em revisão.");
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    try {
      operation = await this.setState(operation, "retrieving_context");
      await this.invalidateConsents(operation.id, "Pacote remontado.");
      const pkg = await this.buildPackage(
        operation,
        [],
        operation.selectedProjectIds,
        controller.signal,
      );
      await this.setState(operation, "awaiting_consent", {
        currentPackageId: pkg.id,
        projectsConsulted: pkg.projectsConsulted,
      });
      return this.view(operation.id);
    } catch (error) {
      await this.fail(operation.id, error, controller.signal.aborted);
      throw error;
    } finally {
      this.controllers.delete(operation.id);
    }
  }

  async setPurpose(input: unknown) {
    const parsed = parseSetPurposeInput(input);
    const { operation, pkg } = this.editablePackage(
      parsed.operationId,
      parsed.packageId,
    );
    await this.store.mutate((tx) =>
      tx.setConfig("last_purpose", parsed.purpose),
    );
    if (pkg.purpose !== parsed.purpose)
      await this.derivePackage(operation, pkg, { purpose: parsed.purpose });
    return this.view(operation.id);
  }

  private async invalidateConsents(operationId: string, _reason: string) {
    const packages = this.store
      .list("context_packages", operationId)
      .map((pkg) => pkg.id);
    const consents = packages
      .flatMap((packageId) => this.store.list("consents", packageId))
      .filter((consent) => !consent.revoked);
    if (!consents.length) return;
    await this.store.mutate((tx) => {
      for (const consent of consents)
        tx.put(
          "consents",
          { ...consent, revoked: true },
          consent.packageId,
          consent.confirmedAt,
        );
    });
    await this.audit(
      "consent_invalidated",
      operationId,
      null,
      consents.map((consent) => consent.id),
    );
  }

  private packageStillValid(
    pkg: ContextPackage,
    ledger: MemoryLedger,
  ): string | null {
    const config = this.modelConfig();
    if (config.provider !== pkg.provider || config.model !== pkg.model)
      return "O provedor ou modelo mudou desde a revisão.";
    if (ledger.globalRevision !== pkg.memoryGlobalRevision)
      return "A memória pessoal mudou desde a revisão.";
    for (const item of pkg.items)
      if (
        item.kind === "memory" &&
        !ledger.revisions.some(
          (revision) =>
            revision.memoryId === item.memoryId &&
            revision.revision === item.memoryRevision &&
            revision.state === "confirmed",
        )
      )
        return "Uma memória incluída não está mais confirmada.";
    const recomputed = sha256(
      JSON.stringify(
        buildGenerationPayload({
          items: pkg.items,
          purpose: pkg.purpose,
          model: pkg.model,
          articleCoverage: pkg.articleCoverage,
          projectsConsulted: pkg.projectsConsulted,
        }),
      ),
    );
    if (recomputed !== pkg.payloadSha256)
      return "O conteúdo do pacote não corresponde ao revisado.";
    return null;
  }

  async deny(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    const operation = this.requireOperation(parsed.operationId);
    if (operation.state !== "awaiting_consent")
      throw new ContractError("Nada aguardando autorização.");
    await this.invalidateConsents(operation.id, "Negado.");
    await this.audit("consent_denied", operation.id, null, []);
    await this.setState(operation, "canceled", {
      error:
        "Envio negado. As evidências locais foram mantidas e nenhum provedor foi chamado.",
    });
    return this.view(operation.id);
  }

  async authorize(input: unknown) {
    const prepared = await this.prepareAuthorization(
      parseAuthorizeInput(input),
    );
    const attempt = prepared.operation.attempt + 1;
    const generating = await this.setState(prepared.operation, "generating", {
      attempt,
    });
    const controller = new AbortController();
    this.controllers.set(generating.id, controller);
    const job = this.runGeneration(
      { ...prepared, operation: generating },
      attempt,
      controller,
    ).finally(() => {
      this.controllers.delete(generating.id);
      this.jobs.delete(generating.id);
    });
    this.jobs.set(generating.id, job);
    return this.view(generating.id);
  }

  private async prepareAuthorization(
    parsed: ReturnType<typeof parseAuthorizeInput>,
  ): Promise<Prepared> {
    const operation = this.requireOperation(parsed.operationId);
    if (
      operation.state !== "awaiting_consent" ||
      operation.currentPackageId !== parsed.packageId
    )
      throw new ConsentError(
        "Este pacote não é o vigente para a operação. Revise novamente.",
      );
    const pkg = this.store.get("context_packages", parsed.packageId);
    if (
      !pkg ||
      pkg.reviewToken !== parsed.reviewToken ||
      pkg.payloadSha256 !== parsed.payloadSha256
    )
      throw new ConsentError(
        "A autorização não corresponde ao pacote exibido.",
      );
    const invalid = this.packageStillValid(pkg, this.store.ledger());
    if (invalid)
      throw new ConsentError(`${invalid} Revise o pacote novamente.`);
    const config = this.modelConfig();
    if (!config.contextTokens)
      throw new ConsentError(
        "Informe a capacidade de contexto do modelo configurado antes de enviar.",
      );
    const budget = Math.min(
      limits.ai.maxPackageTokens,
      config.contextTokens - limits.ai.reservedOutputTokens,
    );
    if (pkg.estimatedTokens > budget)
      throw new ConsentError(
        `O pacote (≈${pkg.estimatedTokens} tokens) excede o limite de ${budget}. Remova itens antes de enviar.`,
      );
    const gateway = this.deps.gateway();
    if (!gateway)
      throw new ConsentError("Configure uma chave OpenAI antes de enviar.");
    const now = this.deps.now();
    const consent: Consent = {
      id: id("cns"),
      packageId: pkg.id,
      operationId: operation.id,
      payloadSha256: pkg.payloadSha256,
      provider: pkg.provider,
      model: pkg.model,
      confirmedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + limits.consentTtlMs).toISOString(),
      revoked: false,
    };
    await this.store.mutate((tx) =>
      tx.put("consents", consent, pkg.id, consent.confirmedAt),
    );
    await this.audit(
      "consent_confirmed",
      operation.id,
      pkg.payloadSha256,
      pkg.items.map((item) => item.id),
    );
    return { operation, pkg, consent, gateway };
  }

  private async runGeneration(
    { operation, pkg, consent, gateway }: Prepared,
    attempt: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const payload = buildGenerationPayload(pkg);
      let result: GatewayResult | null = null;
      for (let call = 1; call <= pkg.callBudget; call += 1) {
        this.assertConsent(consent.id, pkg, attempt);
        await this.audit("call_sent", operation.id, pkg.payloadSha256, []);
        try {
          result = await gateway.call(payload, controller.signal);
          break;
        } catch (error) {
          if (
            controller.signal.aborted ||
            call === pkg.callBudget ||
            !gateway.isTransient(error)
          )
            throw error;
        }
      }
      const current = this.requireOperation(operation.id);
      if (
        current.state !== "generating" ||
        current.attempt !== attempt ||
        this.store.get("consents", consent.id)?.revoked
      ) {
        await this.audit("call_discarded", operation.id, pkg.payloadSha256, []);
        return;
      }
      const validating = await this.setState(current, "validating");
      const projects = new Map(
        this.store
          .list("projects")
          .map((project) => [project.id, project.label]),
      );
      const allowedProjects = new Map(
        [...projects].filter(([projectId]) =>
          pkg.items.some((item) => item.label.endsWith(projectId)),
        ),
      );
      const validated = validateRecommendation(
        parseModelJson(result!.text),
        pkg,
        allowedProjects,
      );
      const recommendation: Recommendation = {
        ...validated,
        id: id("rec"),
        operationId: operation.id,
        createdAt: this.deps.now().toISOString(),
        rating: null,
        contextRevoked: false,
      };
      await this.store.mutate((tx) => {
        tx.put(
          "recommendations",
          recommendation,
          operation.id,
          recommendation.createdAt,
        );
        tx.put(
          "consents",
          { ...consent, revoked: true },
          pkg.id,
          consent.confirmedAt,
        );
      });
      await this.setState(validating, "completed");
    } catch (error) {
      await this.fail(operation.id, error, controller.signal.aborted).catch(
        () => undefined,
      );
    }
  }

  private assertConsent(
    consentId: string,
    pkg: ContextPackage,
    attempt: number,
  ) {
    const consent = this.store.get("consents", consentId);
    const operation = this.requireOperation(pkg.operationId);
    if (!consent || consent.revoked)
      throw new ConsentError("A autorização foi revogada.");
    if (Date.parse(consent.expiresAt) < this.deps.now().getTime())
      throw new ConsentError(
        "A autorização expirou (15 minutos). Revise e autorize novamente.",
      );
    if (
      consent.payloadSha256 !== pkg.payloadSha256 ||
      operation.state !== "generating" ||
      operation.attempt !== attempt
    )
      throw new ConsentError(
        "O estado da operação mudou; o envio foi bloqueado.",
      );
    const invalid = this.packageStillValid(pkg, this.store.ledger());
    if (invalid) throw new ConsentError(invalid);
  }

  async startComparison(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    const source = this.requireOperation(parsed.operationId);
    if (
      source.contextMode !== "full" ||
      source.state !== "completed" ||
      !source.article
    )
      throw new ContractError(
        "A comparação parte de uma exploração com contexto concluída.",
      );
    if (!this.store.list("recommendations", source.id)[0])
      throw new ContractError("A exploração não tem resultado para comparar.");
    const existing = this.store.list("evaluations", source.id)[0];
    if (existing) {
      const plain = this.store.get("operations", existing.plainOperationId);
      if (plain && !["failed", "canceled", "interrupted"].includes(plain.state))
        throw new ContractError("Esta exploração já tem uma comparação.");
    }
    if (this.activeOperation())
      throw new ContractError(
        "Conclua ou cancele a exploração em andamento antes de comparar.",
      );
    const at = this.deps.now().toISOString();
    let operation: Operation = {
      ...source,
      id: id("op"),
      state: "created",
      selectedProjectIds: null,
      projectsConsulted: false,
      attempt: 0,
      currentPackageId: null,
      contextMode: "article_only",
      comparisonOf: source.id,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    const others = this.store
      .list("evaluations")
      .filter((item) => item.contextOperationId !== source.id).length;
    const evaluation: Evaluation = {
      id: existing?.id ?? id("evl"),
      contentId: source.contentId,
      contextOperationId: source.id,
      plainOperationId: operation.id,
      order:
        existing?.order ?? (others % 2 === 0 ? "context_first" : "plain_first"),
      preference: null,
      createdAt: existing?.createdAt ?? at,
      decidedAt: null,
    };
    await this.store.mutate((tx) => {
      tx.put("operations", operation, null, at);
      tx.put("evaluations", evaluation, source.id, evaluation.createdAt);
    });
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    try {
      operation = await this.setState(operation, "acquiring_article");
      return await this.continueWithArticle(
        operation,
        { ...source.article, id: id("art") },
        controller.signal,
      );
    } catch (error) {
      await this.fail(operation.id, error, controller.signal.aborted);
      throw error;
    } finally {
      this.controllers.delete(operation.id);
    }
  }

  private evaluationFor(operation: Operation): Evaluation | null {
    if (operation.contextMode === "article_only" && operation.comparisonOf)
      return (
        this.store
          .list("evaluations", operation.comparisonOf)
          .find((item) => item.plainOperationId === operation.id) ?? null
      );
    return this.store.list("evaluations", operation.id)[0] ?? null;
  }

  comparison(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    const evaluation = this.evaluationFor(
      this.requireOperation(parsed.operationId),
    );
    if (!evaluation)
      throw new ContractError("Não há comparação para esta exploração.");
    const context =
      this.store.list("recommendations", evaluation.contextOperationId)[0] ??
      null;
    const plain =
      this.store.list("recommendations", evaluation.plainOperationId)[0] ??
      null;
    const ready = Boolean(context && plain);
    const [first, second] =
      evaluation.order === "context_first"
        ? [context, plain]
        : [plain, context];
    const strip = (recommendation: Recommendation | null) =>
      recommendation && {
        status: recommendation.status,
        modality: recommendation.modality,
        title: recommendation.title,
        description: recommendation.description,
        firstVersion: recommendation.firstVersion,
        reasons: recommendation.reasons.map((reason) => ({
          text: reason.text,
          inferred: reason.inferred,
        })),
        stack: recommendation.stack,
        limitations: recommendation.limitations,
      };
    const decided = evaluation.preference;
    const contextFirst = evaluation.order === "context_first";
    return {
      evaluationId: evaluation.id,
      ready,
      a: ready ? strip(first) : null,
      b: ready ? strip(second) : null,
      preference:
        decided === null
          ? null
          : decided === "tie"
            ? "tie"
            : (decided === "context") === contextFirst
              ? "A"
              : "B",
      reveal:
        decided === null
          ? null
          : {
              a: contextFirst ? "com contexto" : "sem contexto",
              b: contextFirst ? "sem contexto" : "com contexto",
            },
    };
  }

  async recordPreference(input: unknown) {
    const parsed = strictObject<{
      evaluationId: string;
      choice: "A" | "B" | "tie";
    }>(input, { evaluationId: is.id, choice: is.oneOf("A", "B", "tie") });
    const evaluation = this.store.get("evaluations", parsed.evaluationId);
    if (!evaluation) throw new ContractError("Comparação não encontrada.");
    if (
      !this.store.list("recommendations", evaluation.plainOperationId)[0] ||
      !this.store.list("recommendations", evaluation.contextOperationId)[0]
    )
      throw new ContractError(
        "As duas versões precisam estar prontas antes da escolha.",
      );
    const contextFirst = evaluation.order === "context_first";
    const preference: Evaluation["preference"] =
      parsed.choice === "tie"
        ? "tie"
        : (parsed.choice === "A") === contextFirst
          ? "context"
          : "plain";
    await this.store.mutate((tx) =>
      tx.put(
        "evaluations",
        { ...evaluation, preference, decidedAt: this.deps.now().toISOString() },
        evaluation.contextOperationId,
        evaluation.createdAt,
      ),
    );
    return this.comparison({ operationId: evaluation.contextOperationId });
  }

  async cancel(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    const operation = this.requireOperation(parsed.operationId);
    this.controllers.get(operation.id)?.abort();
    if (operation.state === "retrieving_context")
      await this.deps.isolation.cancel();
    await this.invalidateConsents(operation.id, "Cancelado.");
    if (!terminalStates.has(this.requireOperation(operation.id).state))
      await this.setState(this.requireOperation(operation.id), "canceled", {
        error:
          "Operação cancelada. Requisições já aceitas pelo provedor podem não ser canceláveis.",
      });
    return this.view(operation.id);
  }

  async rate(input: unknown) {
    const parsed = parseRateInput(input);
    const recommendation = this.store.list(
      "recommendations",
      parsed.operationId,
    )[0];
    if (!recommendation) throw new ContractError("Resultado não encontrado.");
    await this.store.mutate((tx) =>
      tx.put(
        "recommendations",
        {
          ...recommendation,
          rating: {
            score: parsed.score,
            comment: (parsed.comment ?? "").trim(),
          },
        },
        recommendation.operationId,
        recommendation.createdAt,
      ),
    );
    return this.view(parsed.operationId);
  }

  view(operationId: string, busy = false) {
    const operation = this.requireOperation(operationId);
    const pkg = operation.currentPackageId
      ? this.store.get("context_packages", operation.currentPackageId)
      : null;
    const recommendation =
      this.store.list("recommendations", operationId)[0] ?? null;
    return {
      busy,
      evaluation: (() => {
        const evaluation = this.evaluationFor(operation);
        return evaluation
          ? { id: evaluation.id, decided: evaluation.preference !== null }
          : null;
      })(),
      operation: {
        id: operation.id,
        contentId: operation.contentId,
        state: operation.state,
        error: operation.error,
        purpose: operation.purpose,
        contextMode: operation.contextMode,
        comparisonOf: operation.comparisonOf,
        projectsConsulted: operation.projectsConsulted,
        selectedProjectIds: operation.selectedProjectIds,
        article: operation.article
          ? {
              title: operation.article.title,
              coverage: operation.article.coverage,
              limitations: operation.article.limitations,
              characters: operation.article.text.length,
              capturedAt: operation.article.capturedAt,
            }
          : null,
      },
      package:
        pkg && operation.state === "awaiting_consent"
          ? {
              id: pkg.id,
              reviewToken: pkg.reviewToken,
              payloadSha256: pkg.payloadSha256,
              provider: pkg.provider,
              model: pkg.model,
              purpose: pkg.purpose,
              estimatedTokens: pkg.estimatedTokens,
              callBudget: pkg.callBudget,
              notices: pkg.notices,
              projectsConsulted: pkg.projectsConsulted,
              items: pkg.items.map((item) => ({
                id: item.id,
                kind: item.kind,
                label: item.label.replace(/ · prj_[A-Za-z0-9_-]+$/, ""),
                text: item.text,
                projectLabel: item.projectLabel ?? null,
                relativePath: item.relativePath ?? null,
                lines: item.lines ?? null,
                memoryKind:
                  item.kind === "memory"
                    ? this.memoryKindOf(item.memoryId)
                    : null,
              })),
            }
          : null,
      recommendation: recommendation
        ? {
            ...recommendation,
            summary: recommendation.summary ?? "",
            terms: this.termsView(recommendation),
            citedEvidence: recommendation.citedEvidence.map((item) => ({
              ...item,
              label: item.label.replace(/ · prj_[A-Za-z0-9_-]+$/, ""),
            })),
          }
        : null,
      modelConfig: this.modelConfig(),
    };
  }

  private termsView(recommendation: Recommendation) {
    const ledger = this.store.ledger();
    const seen = new Set<string>();
    const candidates = [
      ...(recommendation.terms ?? []),
      ...recommendation.stack.map((item) => ({
        name: item.name,
        explanation: "",
      })),
    ];
    return candidates
      .filter((item) => {
        const key = termKey(item.name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10)
      .map((item) => {
        const memory = knowledgeFor(ledger, item.name);
        return {
          name: item.name,
          explanation: item.explanation,
          knowledge: memory
            ? {
                memoryId: memory.memoryId,
                known: memory.known,
                text: memory.text,
              }
            : null,
        };
      });
  }

  async answerKnowledge(input: unknown) {
    const parsed = strictObject<{ term: string; known: boolean }>(input, {
      term: is.text(80, 1),
      known: (value, path) => {
        if (typeof value !== "boolean")
          throw new ContractError(`${path}: booleano esperado.`);
        return value;
      },
    });
    const ledger = answerKnowledge(
      this.store.ledger(),
      { newMemoryId: id("mem"), term: parsed.term, known: parsed.known },
      this.deps.now().toISOString(),
    );
    await this.store.mutate((tx) => tx.writeLedger(ledger));
    return knowledgeFor(ledger, parsed.term);
  }

  private memoryKindOf(memoryId: string | undefined) {
    return (
      this.store
        .ledger()
        .revisions.find((revision) => revision.memoryId === memoryId)?.kind ??
      null
    );
  }

  detail(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    return this.view(parsed.operationId);
  }

  history(input: unknown) {
    const parsed = strictObject<{ purpose?: Purpose }>(input ?? {}, {
      purpose: is.optional(is.oneOf("portfolio", "practical", "both")),
    });
    const operations = new Map(
      this.store
        .list("operations")
        .map((operation) => [operation.id, operation]),
    );
    return this.store
      .list("recommendations")
      .filter(
        (recommendation) =>
          recommendation.status === "recommendation" &&
          operations.get(recommendation.operationId)?.contextMode === "full",
      )
      .filter(
        (recommendation) =>
          !parsed.purpose || recommendation.purpose === parsed.purpose,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((recommendation) => {
        const operation = operations.get(recommendation.operationId)!;
        return {
          operationId: operation.id,
          title: recommendation.title,
          modality: recommendation.modality,
          purpose: recommendation.purpose,
          createdAt: recommendation.createdAt,
          articleTitle: operation.article?.title ?? "",
          contentId: operation.contentId,
          rating: recommendation.rating?.score ?? null,
          contextRevoked: recommendation.contextRevoked,
        };
      });
  }

  async deleteIdea(input: unknown) {
    const parsed = strictObject<{ operationId: string }>(input, {
      operationId: is.id,
    });
    const operation = this.requireOperation(parsed.operationId);
    if (!terminalStates.has(operation.state))
      throw new ContractError("Aguarde a geração terminar antes de excluir.");
    const linked = this.store
      .list("operations")
      .filter((candidate) => candidate.comparisonOf === operation.id);
    if (linked.some((candidate) => !terminalStates.has(candidate.state)))
      throw new ContractError(
        "A comparação desta ideia ainda está em andamento.",
      );
    await this.store.mutate((tx) => {
      for (const candidate of linked) tx.removeOperationData(candidate.id);
      tx.removeOperationData(operation.id);
    });
    return this.history({});
  }

  ignoredList() {
    return this.store
      .list("ignored_sources")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async unignore(input: unknown) {
    const parsed = strictObject<{ id: string }>(input, { id: is.id });
    if (!this.store.get("ignored_sources", parsed.id))
      throw new ContractError("Item ignorado não encontrado.");
    await this.store.mutate((tx) => tx.delete("ignored_sources", parsed.id));
    return this.ignoredList();
  }

  async setMemoryIgnored(input: unknown) {
    const parsed = strictObject<{ memoryId: string; ignored: boolean }>(input, {
      memoryId: is.id,
      ignored: (value, path) => {
        if (typeof value !== "boolean")
          throw new ContractError(`${path}: booleano esperado.`);
        return value;
      },
    });
    const existing = this.store
      .list("ignored_sources")
      .filter(
        (entry) =>
          entry.kind === "memory" && entry.memoryId === parsed.memoryId,
      );
    const memory = this.store
      .ledger()
      .revisions.find((revision) => revision.memoryId === parsed.memoryId);
    if (!memory) throw new ContractError("Memória não encontrada.");
    await this.store.mutate((tx) => {
      for (const entry of existing) tx.delete("ignored_sources", entry.id);
      if (parsed.ignored)
        tx.put(
          "ignored_sources",
          {
            id: id("ign"),
            kind: "memory",
            relativePath: null,
            memoryId: parsed.memoryId,
            label: memory.text.slice(0, 160),
            createdAt: this.deps.now().toISOString(),
          },
          null,
          this.deps.now().toISOString(),
        );
    });
    return this.memoryList();
  }

  current() {
    const operation =
      this.activeOperation() ?? this.store.list("operations").at(-1) ?? null;
    return operation ? this.view(operation.id) : null;
  }

  readEvidence(input: unknown) {
    const parsed = strictObject<{ operationId: string; itemId: string }>(
      input,
      { operationId: is.id, itemId: is.id },
    );
    const recommendation = this.store.list(
      "recommendations",
      parsed.operationId,
    )[0];
    const cited = recommendation?.citedEvidence.find(
      (item) => item.id === parsed.itemId,
    );
    if (cited) {
      const version = cited.sourceVersionId
        ? this.store.get("source_versions", cited.sourceVersionId)
        : null;
      return {
        label: cited.label.replace(/ · prj_[A-Za-z0-9_-]+$/, ""),
        text: cited.excerpt,
        version: version
          ? {
              sha256: version.sha256,
              modifiedAt: version.modifiedAt,
              relativePath: version.relativePath,
            }
          : null,
        historical: true,
      };
    }
    const operation = this.requireOperation(parsed.operationId);
    const pkg = operation.currentPackageId
      ? this.store.get("context_packages", operation.currentPackageId)
      : null;
    const item = pkg?.items.find((candidate) => candidate.id === parsed.itemId);
    if (!item) throw new ContractError("Trecho não encontrado.");
    return {
      label: item.label.replace(/ · prj_[A-Za-z0-9_-]+$/, ""),
      text: item.text,
      version: null,
      historical: false,
    };
  }

  async setModelConfig(input: unknown) {
    const parsed = strictObject<{ model: string; contextTokens: number }>(
      input,
      { model: is.text(80, 2), contextTokens: is.integer(8_000, 2_000_000) },
    );
    if (!/^[A-Za-z0-9._:-]+$/.test(parsed.model))
      throw new ContractError("Nome de modelo inválido.");
    await this.store.mutate((tx) =>
      tx.setConfig(
        "model_config",
        JSON.stringify({
          provider: "openai",
          model: parsed.model,
          contextTokens: parsed.contextTokens,
        } satisfies ModelConfig),
      ),
    );
    const active = this.activeOperation();
    if (active) await this.invalidateConsents(active.id, "Modelo alterado.");
    return this.modelConfig();
  }

  async contextStatus() {
    const isolation = await this.deps.isolation.status();
    const last = this.store.getConfig("last_catalog");
    return {
      isolation,
      policySha256: this.deps.isolation.policySha256,
      projects: this.store
        .list("projects")
        .map((project) => ({
          id: project.id,
          label: project.label,
          status: project.status,
          updatedAt: project.updatedAt,
        })),
      lastCatalog: last
        ? (JSON.parse(last) as { at: string; coverage: CatalogCoverage })
        : null,
    };
  }

  async refreshContext(input: unknown) {
    const parsed = strictObject<{ projectIds?: string[] }>(input ?? {}, {
      projectIds: is.optional(is.idList(200)),
    });
    const operation = this.activeOperation();
    if (
      operation &&
      ["retrieving_context", "generating", "validating"].includes(
        operation.state,
      )
    )
      throw new ContractError("Aguarde a operação atual terminar.");
    const labels = parsed.projectIds
      ?.map((projectId) => this.store.get("projects", projectId)?.relativeRoot)
      .filter((value): value is string => Boolean(value));
    const graph = this.store.graphExpansionEnabled();
    const result = await this.deps.isolation.run(
      "catalog",
      labels ? { projects: labels, graph } : { graph },
    );
    const coverage = await ingestCatalog(
      this.store,
      result.response,
      result.projectFiles,
      this.deps.now(),
    );
    return { coverage, status: await this.contextStatus() };
  }

  async setRealSources(input: unknown) {
    const parsed = strictObject<{ enabled: boolean }>(input, {
      enabled: (value, path) => {
        if (typeof value !== "boolean")
          throw new ContractError(`${path}: booleano esperado.`);
        return value;
      },
    });
    if (parsed.enabled) {
      const status = await this.deps.isolation.status();
      if (status.state !== "disabled" && status.state !== "ready")
        throw new ContractError(
          `A leitura só pode ser ativada depois do Gate 0 aprovado. ${status.reasons.join(" ")}`,
        );
    }
    await this.store.mutate((tx) =>
      tx.setConfig("real_sources_enabled", parsed.enabled ? "true" : "false"),
    );
    if (!parsed.enabled) await this.deps.isolation.cancel();
    return this.contextStatus();
  }

  async removeProjectContext(input: unknown) {
    const parsed = strictObject<{ projectId: string }>(input, {
      projectId: is.id,
    });
    const dependent = this.store
      .list("recommendations")
      .filter((recommendation) =>
        recommendation.citedEvidence.some((item) =>
          item.label.endsWith(parsed.projectId),
        ),
      );
    await this.store.mutate((tx) => {
      for (const recommendation of dependent)
        tx.removeOperationData(recommendation.operationId);
      for (const evidence of this.store.list("evidence", parsed.projectId))
        tx.delete("evidence", evidence.id);
      tx.deleteByRef("source_versions", parsed.projectId);
      tx.delete("projects", parsed.projectId);
    });
    await this.store.removeIndex(parsed.projectId);
    await this.audit("context_removed", "op_contextremoval", null, [
      parsed.projectId,
    ]);
    return this.contextStatus();
  }

  memoryList() {
    const ledger = this.store.ledger();
    const ignored = this.store.ignoredMemories();
    return {
      globalRevision: ledger.globalRevision,
      memories: memoryView(ledger).map((entry) => ({
        ...entry,
        ignoredInIdeas: ignored.has(entry.memoryId),
      })),
      kinds: memoryKinds,
    };
  }

  async memoryPropose(input: unknown) {
    const parsed = strictObject<{
      kind?: MemoryKind;
      text?: string;
      fromInterests?: boolean;
    }>(input, {
      kind: is.optional(is.oneOf(...memoryKinds)),
      text: is.optional(is.text(1200, 3)),
      fromInterests: is.optional((value, path) => {
        if (value !== true) throw new ContractError(`${path}: use true.`);
        return value;
      }),
    });
    const at = this.deps.now().toISOString();
    let ledger = this.store.ledger();
    if (parsed.fromInterests) {
      const existing = new Set(
        ledger.revisions.map((revision) => revision.text.toLowerCase()),
      );
      for (const statement of this.deps.interestStatements().slice(0, 10)) {
        if (existing.has(statement.text.toLowerCase())) continue;
        ledger = propose(
          ledger,
          {
            memoryId: id("mem"),
            kind: statement.kind,
            text: statement.text,
            origin: "interest_profile",
            references: [statement.reference],
          },
          at,
        );
      }
    } else {
      if (!parsed.kind || !parsed.text)
        throw new ContractError("Informe tipo e texto da declaração.");
      ledger = propose(
        ledger,
        {
          memoryId: id("mem"),
          kind: parsed.kind,
          text: parsed.text,
          origin: "user_declared",
        },
        at,
      );
    }
    await this.store.mutate((tx) => tx.writeLedger(ledger));
    return this.memoryList();
  }

  private async memoryMutation(
    input: unknown,
    apply: (
      ledger: MemoryLedger,
      parsed: {
        memoryId: string;
        revision: number;
        expectedRevision: number;
        text?: string;
      },
    ) => MemoryLedger,
    spec: Record<string, (value: unknown, path: string) => unknown>,
  ) {
    const parsed = strictObject<{
      memoryId: string;
      revision: number;
      expectedRevision: number;
      text?: string;
    }>(input, {
      memoryId: is.id,
      expectedRevision: is.integer(1, 1_000_000),
      ...spec,
    });
    const ledger = apply(this.store.ledger(), parsed);
    await this.store.mutate((tx) => tx.writeLedger(ledger));
    return ledger;
  }

  async memoryConfirm(input: unknown) {
    await this.memoryMutation(
      input,
      (ledger, parsed) =>
        confirm(
          ledger,
          parsed.memoryId,
          parsed.revision,
          parsed.expectedRevision,
          this.deps.now().toISOString(),
        ),
      { revision: is.integer(1, 1_000_000) },
    );
    await this.invalidateActive("Memória confirmada.");
    return this.memoryList();
  }

  async memoryCorrect(input: unknown) {
    await this.memoryMutation(
      input,
      (ledger, parsed) =>
        correct(
          ledger,
          parsed.memoryId,
          parsed.text!,
          parsed.expectedRevision,
          this.deps.now().toISOString(),
        ),
      { text: is.text(1200, 3) },
    );
    return this.memoryList();
  }

  async memoryDiscard(input: unknown) {
    await this.memoryMutation(
      input,
      (ledger, parsed) =>
        discard(ledger, parsed.memoryId, parsed.expectedRevision),
      {},
    );
    return this.memoryList();
  }

  async memoryRevoke(input: unknown) {
    const parsed = strictObject<{ memoryId: string; expectedRevision: number }>(
      input,
      { memoryId: is.id, expectedRevision: is.integer(1, 1_000_000) },
    );
    const ledger = revoke(
      this.store.ledger(),
      parsed.memoryId,
      parsed.expectedRevision,
      this.deps.now().toISOString(),
    );
    await this.store.mutate((tx) => {
      tx.writeLedger(ledger);
      for (const recommendation of this.dependentRecommendations(
        parsed.memoryId,
      ))
        tx.put(
          "recommendations",
          { ...recommendation, contextRevoked: true },
          recommendation.operationId,
          recommendation.createdAt,
        );
    });
    await this.cancelDependent(parsed.memoryId);
    return {
      ...this.memoryList(),
      notice:
        "Memória revogada. Resultados anteriores que a usaram continuam no histórico, marcados como baseados em contexto revogado.",
    };
  }

  async memoryForget(input: unknown) {
    const parsed = strictObject<{ memoryId: string }>(input, {
      memoryId: is.id,
    });
    await this.cancelDependent(parsed.memoryId);
    const ledger = forget(
      this.store.ledger(),
      parsed.memoryId,
      this.deps.now().toISOString(),
    );
    const dependent = this.dependentOperations(parsed.memoryId);
    await this.store.mutate((tx) => {
      tx.writeLedger(ledger);
      for (const operationId of dependent) tx.removeOperationData(operationId);
      for (const entry of this.store.list("ignored_sources"))
        if (entry.memoryId === parsed.memoryId)
          tx.delete("ignored_sources", entry.id);
    });
    await this.audit("memory_forgotten", "op_memoryforget", null, []);
    return {
      ...this.memoryList(),
      notice:
        "Memória esquecida. Texto, revisões, pacotes e resultados dependentes foram removidos deste aplicativo; dados já recebidos por provedores não podem ser recolhidos.",
    };
  }

  private dependentOperations(memoryId: string): string[] {
    return [
      ...new Set(
        this.store
          .list("context_packages")
          .filter((pkg) => pkg.items.some((item) => item.memoryId === memoryId))
          .map((pkg) => pkg.operationId),
      ),
    ];
  }

  private dependentRecommendations(memoryId: string): Recommendation[] {
    const operations = new Set(this.dependentOperations(memoryId));
    return this.store
      .list("recommendations")
      .filter((recommendation) => operations.has(recommendation.operationId));
  }

  private async cancelDependent(memoryId: string) {
    const active = this.activeOperation();
    if (!active) return;
    const pkg = active.currentPackageId
      ? this.store.get("context_packages", active.currentPackageId)
      : null;
    if (
      pkg?.items.some((item) => item.memoryId === memoryId) ||
      active.state === "generating"
    ) {
      this.controllers.get(active.id)?.abort();
      await this.invalidateConsents(active.id, "Memória retirada.");
      const current = this.requireOperation(active.id);
      if (!terminalStates.has(current.state))
        await this.setState(current, "canceled", {
          error:
            "Uma memória usada no pacote foi retirada; a operação foi cancelada.",
        });
    }
  }

  private async invalidateActive(reason: string) {
    const active = this.activeOperation();
    if (active) await this.invalidateConsents(active.id, reason);
  }

  async shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
    await this.deps.isolation.cancel();
  }
}

export function createOpenAIGateway(apiKey: string): Gateway {
  const client = new OpenAI({
    apiKey,
    timeout: limits.ai.timeoutMs,
    maxRetries: 0,
  });
  return {
    provider: "openai",
    call: async (payload, signal) => {
      const response = await client.responses.create(
        {
          model: payload.model,
          instructions: payload.instructions,
          input: payload.input,
          max_output_tokens: limits.ai.reservedOutputTokens,
          store: false,
        },
        { signal },
      );
      return {
        text: response.output_text,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
      };
    },
    isTransient: isTransientProviderError,
  };
}

export function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof APIConnectionError ||
    (error instanceof APIError &&
      (error.status === 429 || (error.status ?? 0) >= 500))
  );
}
