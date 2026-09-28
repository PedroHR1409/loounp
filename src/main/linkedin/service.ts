import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { LINKEDIN_POST_GENERATION_PROMPT } from "./prompts/generation";
import { LINKEDIN_HUMANIZER_REVIEW_PROMPT } from "./prompts/humanizer";
import {
  recommendLinkedInSlot,
  type LinkedInPostRecord,
} from "../../core/linkedin/posts";
import type { ArticleSnapshot } from "../../core/project-ideas/contracts";

const SETTING_KEY = "linkedin_posts_v1";
const MAX_HISTORY = 100;
const MAX_SOURCE_CHARS = 18_000;

export type LinkedInPostSource =
  | { kind: "article_url"; url: string; title?: string }
  | { kind: "article_text"; text: string; title?: string }
  | { kind: "feed_article"; contentId: string }
  | { kind: "idea_text"; text: string; title?: string }
  | { kind: "saved_idea"; operationId: string };

export type LinkedInPostDependencies = {
  now: () => Date;
  getApiKey: () => Promise<string>;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  persist: () => Promise<void>;
  getFeedArticle: (contentId: string) =>
    | { title: string; url: string }
    | null;
  readArticle: (
    url: string,
    origin: { kind: "url"; url: string } | { kind: "item"; contentId: string; url: string },
    fallbackTitle?: string,
  ) => Promise<ArticleSnapshot>;
  getSavedIdea: (operationId: string) => Promise<{
    title: string;
    summary: string;
    description: string;
    firstVersion: string;
    limitations: string[];
  } | null>;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Solicitação de post inválida.");
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${label} está vazio.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} está vazio.`);
  return trimmed.slice(0, maximum);
}

function parseSource(value: unknown): LinkedInPostSource {
  const source = object(value);
  switch (source.kind) {
    case "article_url": {
      const url = boundedText(source.url, "Informe o endereço do artigo", 2000);
      return {
        kind: "article_url",
        url,
        title: typeof source.title === "string" ? source.title.slice(0, 240) : "",
      };
    }
    case "article_text":
      return {
        kind: "article_text",
        text: boundedText(source.text, "Cole o texto do artigo", MAX_SOURCE_CHARS),
        title: typeof source.title === "string" ? source.title.slice(0, 240) : "",
      };
    case "feed_article":
      return {
        kind: "feed_article",
        contentId: boundedText(source.contentId, "Selecione um artigo", 200),
      };
    case "idea_text":
      return {
        kind: "idea_text",
        text: boundedText(source.text, "Descreva a ideia", MAX_SOURCE_CHARS),
        title: typeof source.title === "string" ? source.title.slice(0, 240) : "",
      };
    case "saved_idea":
      return {
        kind: "saved_idea",
        operationId: boundedText(source.operationId, "Selecione uma ideia", 200),
      };
    default:
      throw new Error("Tipo de fonte inválido.");
  }
}

function readHistory(deps: LinkedInPostDependencies): LinkedInPostRecord[] {
  const stored = deps.getSetting(SETTING_KEY);
  if (!stored) return [];
  try {
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value) ? (value as LinkedInPostRecord[]).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function trimOutput(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function parseGeneration(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = object(JSON.parse(cleaned) as unknown);
  const rawHooks = Array.isArray(value.hooks) ? value.hooks : [];
  const hooks = rawHooks.map((hook) => trimOutput(hook, 220)).filter(Boolean).slice(0, 3);
  while (hooks.length < 3) hooks.push(hooks[hooks.length - 1] ?? "Uma observação prática sobre dados e IA");
  const post = trimOutput(value.post, 5000);
  if (!post) throw new Error("A IA não retornou o rascunho do post.");
  return {
    hooks: hooks as [string, string, string],
    post,
    angle: trimOutput(value.angle, 300),
    engagementRationale: trimOutput(value.engagementRationale, 500),
  };
}

export class LinkedInPostsService {
  constructor(private readonly deps: LinkedInPostDependencies) {}

  list() {
    return readHistory(this.deps);
  }

  async generate(input: unknown): Promise<LinkedInPostRecord> {
    const parsed = object(input);
    const source = parseSource(parsed.source);
    const material = await this.loadSource(source);
    if (!material.text.trim()) throw new Error("Não encontrei texto suficiente para criar o post.");

    const apiKey = await this.deps.getApiKey();
    const client = new OpenAI({ apiKey, timeout: 45_000, maxRetries: 0 });
    const response = await client.responses.create({
      model: "gpt-5.6-luna",
      store: false,
      max_output_tokens: 1400,
      input: [
        {
          role: "system",
          content: LINKEDIN_POST_GENERATION_PROMPT,
        },
        {
          role: "system",
          content: LINKEDIN_HUMANIZER_REVIEW_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify({
            idioma: "pt-BR",
            tema: "IA e Engenharia de Dados",
            objetivo: "alcance qualificado, conversa relevante e salvamentos",
            sourceKind: material.kind,
            sourceTitle: material.title,
            sourceText: material.text.slice(0, MAX_SOURCE_CHARS),
          }),
        },
      ],
    });
    const generated = parseGeneration(response.output_text);
    const now = this.deps.now();
    const record: LinkedInPostRecord = {
      id: randomUUID(),
      createdAt: now.toISOString(),
      sourceTitle: material.title,
      sourceKind: material.kind,
      hooks: generated.hooks,
      selectedHook: generated.hooks[0],
      post: generated.post,
      angle: generated.angle,
      engagementRationale: generated.engagementRationale,
      recommendedAt: recommendLinkedInSlot(now),
    };
    await this.writeHistory([record, ...this.list()]);
    return record;
  }

  async update(input: unknown): Promise<LinkedInPostRecord[]> {
    const parsed = object(input);
    const id = boundedText(parsed.id, "Rascunho inválido", 80);
    const post = boundedText(parsed.post, "O texto do post", 5000);
    const selectedHook = boundedText(parsed.selectedHook, "O gancho", 220);
    const history = this.list();
    const index = history.findIndex((record) => record.id === id);
    if (index < 0) throw new Error("Rascunho não encontrado.");
    history[index] = { ...history[index], post, selectedHook };
    await this.writeHistory(history);
    return history;
  }

  async delete(input: unknown): Promise<LinkedInPostRecord[]> {
    const parsed = object(input);
    const id = boundedText(parsed.id, "Rascunho inválido", 80);
    const history = this.list().filter((record) => record.id !== id);
    await this.writeHistory(history);
    return history;
  }

  private async writeHistory(history: LinkedInPostRecord[]) {
    this.deps.setSetting(SETTING_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
    await this.deps.persist();
  }

  private async loadSource(source: LinkedInPostSource) {
    if (source.kind === "article_url") {
      const article = await this.deps.readArticle(
        source.url,
        { kind: "url", url: source.url },
        source.title,
      );
      return { kind: "article" as const, title: article.title || source.title || source.url, text: article.text };
    }
    if (source.kind === "article_text")
      return { kind: "article" as const, title: source.title || "Artigo colado", text: source.text };
    if (source.kind === "feed_article") {
      const item = this.deps.getFeedArticle(source.contentId);
      if (!item) throw new Error("Artigo não encontrado no feed.");
      const article = await this.deps.readArticle(
        item.url,
        { kind: "item", contentId: source.contentId, url: item.url },
        item.title,
      );
      return { kind: "article" as const, title: article.title || item.title, text: article.text };
    }
    if (source.kind === "idea_text")
      return {
        kind: "idea" as const,
        title: source.title || "Ideia informada pelo usuário",
        text: source.text,
      };

    const idea = await this.deps.getSavedIdea(source.operationId);
    if (!idea) throw new Error("Ideia salva não encontrada ou sem recomendação.");
    const text = [idea.summary, idea.description, idea.firstVersion]
      .concat(idea.limitations.map((limitation) => `Limitação: ${limitation}`))
      .filter(Boolean)
      .join("\n\n");
    return { kind: "idea" as const, title: idea.title, text };
  }
}
