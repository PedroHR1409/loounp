import { terminalStates, type OperationState } from "../../core/project-ideas/contracts";
import { canonicalizeUrl } from "../../core/content-discovery/content";
import { isInterestProfileV2 } from "../../core/content-discovery/interest-profile";
import { validateFeedUrl } from "../../core/content-discovery/feed-url";
import {
  SCHEMA_VERSION,
  type EntityTable,
  type ProjectContextStore,
  type RawConfigRow,
} from "../project-context/store";

export const FORMAT = "loounp-backup";
export const FORMAT_VERSION = 2;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const MAX_BACKUP_ROWS = 100_000;
const VALID_FEEDBACK_ACTIONS = new Set([
  "open",
  "save",
  "unsave",
  "rate",
  "hide",
  "unhide",
]);
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "openai_key",
  "jev_key",
  "typesafe_jev_key",
]);
export const LOCAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "real_sources_enabled",
  "semantic_rerank_enabled",
]);
export const CONTEXT_TABLES = [
  "operations",
  "articles",
  "recommendations",
  "evaluations",
  "ignored_sources",
  "saved_theme_ideas",
] as const satisfies readonly EntityTable[];
export const CLEARED_ON_IMPORT = [
  "context_packages",
  "consents",
] as const satisfies readonly EntityTable[];

type ContextTable = (typeof CONTEXT_TABLES)[number];
type JsonObject = Record<string, unknown>;

function redactCredentialUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.username || url.password)
    ) {
      url.username = "";
      url.password = "";
      return url.toString();
    }
  } catch {
    /* Plain text is not a URL. */
  }
  return value;
}

function redactCredentialUrls(value: unknown): unknown {
  if (typeof value === "string") {
    const direct = redactCredentialUrl(value);
    if (direct !== value) return direct;
    if (value.trimStart().startsWith("{") || value.trimStart().startsWith("[")) {
      try {
        return JSON.stringify(redactCredentialUrls(JSON.parse(value)));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactCredentialUrls);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactCredentialUrls(item),
      ]),
    );
  return value;
}

function validateProfileSettings(settings: SettingRow[]) {
  for (const row of settings) {
    if (!["profile", "profile_v2", "profile_v2_draft"].includes(row.key))
      continue;
    if (row.key === "profile_v2_draft" && !row.value.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      throw new BackupFormatError(`A configuração ${row.key} contém JSON inválido.`);
    }
    if (row.key === "profile_v2" || row.key === "profile_v2_draft") {
      if (!isInterestProfileV2(value))
        throw new BackupFormatError(`A configuração ${row.key} não segue o schema atual.`);
      continue;
    }
    if (
      !isObject(value) ||
      !Array.isArray(value.topics) ||
      value.topics.length > 12 ||
      !Array.isArray(value.mediumFeeds) ||
      value.mediumFeeds.length > 10 ||
      typeof value.recencyPreference !== "number" ||
      !Number.isFinite(value.recencyPreference) ||
      value.recencyPreference < 0 ||
      value.recencyPreference > 1 ||
      value.topics.some(
        (topic) =>
          !isObject(topic) ||
          (typeof topic.name !== "string" && typeof topic.topic !== "string") ||
          !String(topic.name ?? topic.topic).trim() ||
          typeof topic.importance !== "number" ||
          !Number.isInteger(topic.importance) ||
          topic.importance < 1 ||
          topic.importance > 5,
      ) ||
      value.mediumFeeds.some((feed) => {
        try {
          validateFeedUrl(feed);
          return false;
        } catch {
          return true;
        }
      })
    )
      throw new BackupFormatError("A configuração profile não segue o schema atual.");
  }
}

export type ContentRow = {
  id: string;
  url: string;
  source: string;
  data: JsonObject;
};
export type FeedbackRow = {
  id: number;
  content_id: string;
  action: string;
  value: string | null;
  created_at: string;
};
export type SignalRow = { content_id: string; signal: string };
export type SettingRow = { key: string; value: string };
export type EntityRow = {
  id: string;
  ref: string | null;
  created_at: string;
  data: JsonObject;
};
export type MemoryRevisionRow = {
  memory_id: string;
  revision: number;
  state: string;
  data: JsonObject;
};
export type MemoryTombstoneRow = { memory_id: string; forgotten_at: string };

export type BackupFile = {
  format: typeof FORMAT;
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  contentDiscovery: {
    content: ContentRow[];
    feedback: FeedbackRow[];
    mediumArchiveSignals: SignalRow[];
    settings: SettingRow[];
  };
  projectContext: {
    schemaVersion: number;
    config: SettingRow[];
    tables: Record<ContextTable, EntityRow[]>;
    memoryRevisions: MemoryRevisionRow[];
    memoryTombstones: MemoryTombstoneRow[];
  } | null;
};

export type BackupCounts = {
  articles: number;
  feedback: number;
  mediumSignals: number;
  ideas: number;
  capturedArticles: number;
  evaluations: number;
  ignoredSources: number;
  memories: number;
  forgottenMemories: number;
  projectContextIncluded: boolean;
};

export type ContentDbPort = {
  databaseFile(): string;
  dumpTable<T>(
    table: "content" | "feedback" | "medium_archive_signals" | "settings",
  ): T[];
  transaction(
    fn: (run: (sql: string, params?: unknown[]) => void) => void,
  ): void;
  exportBytes(): Uint8Array;
  restoreBytes(bytes: Uint8Array): void;
  persist(): Promise<void>;
};

export type ContextStorePort = Pick<
  ProjectContextStore,
  | "databaseFile"
  | "dumpRaw"
  | "dumpMemory"
  | "dumpConfig"
  | "mutate"
  | "replaceDatabase"
>;

export type ApplyDeps = {
  content: ContentDbPort;
  context: ContextStorePort | null;
  now: () => Date;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
};

export type ApplyResult = { backups: string[]; counts: BackupCounts };

export class BackupFormatError extends Error {}

const interruptedMessage =
  "O aplicativo foi fechado durante a operação; nada foi enviado automaticamente.";

export function buildBackup(input: {
  content: ContentDbPort;
  context: ContextStorePort | null;
  now: () => Date;
  appVersion: string;
}): BackupFile {
  const { content, context } = input;
  const parse = <T extends { data: string }>(
    row: T,
  ): Omit<T, "data"> & { data: JsonObject } => ({
    ...row,
    data: redactCredentialUrls(JSON.parse(row.data)) as JsonObject,
  });
  const backup: BackupFile = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: input.now().toISOString(),
    appVersion: input.appVersion,
    contentDiscovery: {
      content: content
        .dumpTable<{ id: string; url: string; source: string; data: string }>(
          "content",
        )
        .map((row) => ({
          ...parse(row),
          url: redactCredentialUrl(row.url),
        })),
      feedback: content.dumpTable<FeedbackRow>("feedback"),
      mediumArchiveSignals: content.dumpTable<SignalRow>(
        "medium_archive_signals",
      ),
      settings: content
        .dumpTable<SettingRow>("settings")
        .filter((row) => !SECRET_SETTING_KEYS.has(row.key))
        .map((row) => ({
          ...row,
          value: redactCredentialUrls(row.value) as string,
        })),
    },
    projectContext: context
      ? {
          schemaVersion: SCHEMA_VERSION,
          config: context
            .dumpConfig()
            .filter((row) => !LOCAL_CONFIG_KEYS.has(row.key)),
          tables: Object.fromEntries(
            CONTEXT_TABLES.map((table) => [
              table,
              context.dumpRaw(table).map(parse),
            ]),
          ) as Record<ContextTable, EntityRow[]>,
          memoryRevisions: context.dumpMemory().revisions.map(parse),
          memoryTombstones: context.dumpMemory().tombstones,
        }
      : null,
  };
  validateBackupLimits(backup);
  validateBackupReferences(backup);
  return backup;
}

function validateBackupLimits(backup: BackupFile) {
  const sections: Array<[string, unknown[]]> = [
    ["content", backup.contentDiscovery.content],
    ["feedback", backup.contentDiscovery.feedback],
    ["mediumArchiveSignals", backup.contentDiscovery.mediumArchiveSignals],
    ["settings", backup.contentDiscovery.settings],
  ];
  if (backup.projectContext) {
    sections.push(["config", backup.projectContext.config]);
    for (const table of CONTEXT_TABLES)
      sections.push([table, backup.projectContext.tables[table]]);
    sections.push(["memoryRevisions", backup.projectContext.memoryRevisions]);
    sections.push(["memoryTombstones", backup.projectContext.memoryTombstones]);
  }
  for (const [section, values] of sections)
    if (values.length > MAX_BACKUP_ROWS)
      throw new BackupFormatError(
        `Backup section "${section}" exceeds ${MAX_BACKUP_ROWS} rows.`,
      );
  if (Buffer.byteLength(JSON.stringify(backup), "utf8") > MAX_BACKUP_BYTES)
    throw new BackupFormatError("Backup exceeds the 100 MiB export limit.");
}

export function summarize(backup: BackupFile): BackupCounts {
  const context = backup.projectContext;
  return {
    articles: backup.contentDiscovery.content.length,
    feedback: backup.contentDiscovery.feedback.length,
    mediumSignals: backup.contentDiscovery.mediumArchiveSignals.length,
    ideas: context?.tables.recommendations.length ?? 0,
    capturedArticles: context?.tables.articles.length ?? 0,
    evaluations: context?.tables.evaluations.length ?? 0,
    ignoredSources: context?.tables.ignored_sources.length ?? 0,
    memories: new Set(
      context?.memoryRevisions.map((row) => row.memory_id) ?? [],
    ).size,
    forgottenMemories: context?.memoryTombstones.length ?? 0,
    projectContextIncluded: context !== null,
  };
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isInteger = (value: unknown): value is number => Number.isInteger(value);

function rows<T>(
  value: unknown,
  section: string,
  valid: (row: JsonObject) => boolean,
): T[] {
  if (!Array.isArray(value))
    throw new BackupFormatError(
      `Backup inválido: a seção "${section}" está ausente ou não é uma lista.`,
    );
  if (value.length > MAX_BACKUP_ROWS)
    throw new BackupFormatError(
      `Backup section "${section}" exceeds ${MAX_BACKUP_ROWS} rows.`,
    );
  value.forEach((row, index) => {
    if (!isObject(row) || !valid(row))
      throw new BackupFormatError(
        `Backup inválido: item ${index + 1} da seção "${section}" está malformado.`,
      );
  });
  return value as T[];
}

const entityRow = (row: JsonObject) =>
  isString(row.id) &&
  isNullableString(row.ref) &&
  isString(row.created_at) &&
  isObject(row.data);
const settingRow = (row: JsonObject) =>
  isString(row.key) && isString(row.value);

function ensureUnique<T>(items: T[], key: (item: T) => string, section: string) {
  const keys = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (keys.has(value))
      throw new BackupFormatError(`Duplicate identifier in ${section}.`);
    keys.add(value);
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validArticleSnapshot(value: unknown): value is JsonObject {
  if (!isObject(value) || !isObject(value.origin)) return false;
  const origin = value.origin;
  const validUrl = (url: unknown) => {
    if (typeof url !== "string" || url.length > 2048) return false;
    try {
      const parsed = new URL(url);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  };
  const validOrigin =
    (origin.kind === "text") ||
    (origin.kind === "url" && validUrl(origin.url)) ||
    (origin.kind === "item" && typeof origin.contentId === "string" &&
      (origin.url === undefined || validUrl(origin.url)));
  return Boolean(
    value.id &&
    validOrigin &&
    typeof value.title === "string" &&
    value.title.length <= 300 &&
    typeof value.text === "string" &&
    value.text.length <= 80_000 &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(value.sha256) &&
    ["main_text", "user_text", "partial", "metadata_only"].includes(String(value.coverage)) &&
    stringArray(value.limitations) &&
    validTimestamp(value.capturedAt),
  );
}

function validRecommendation(value: JsonObject): boolean {
  const validEffort =
    value.effort === null ||
    (isObject(value.effort) &&
      typeof value.effort.estimate === "string" &&
      stringArray(value.effort.assumptions));
  const validRating =
    value.rating === null ||
    (isObject(value.rating) &&
      Number.isInteger(value.rating.score) &&
      Number(value.rating.score) >= 1 &&
      Number(value.rating.score) <= 5 &&
      typeof value.rating.comment === "string" &&
      (value.rating.clearLanguage === undefined ||
        typeof value.rating.clearLanguage === "boolean"));
  return (
    typeof value.id === "string" &&
    typeof value.operationId === "string" &&
    (value.packageId === null || typeof value.packageId === "string") &&
    ["recommendation", "insufficient_context", "no_application", "canceled", "failed"].includes(String(value.status)) &&
    ["portfolio", "practical", "both"].includes(String(value.purpose)) &&
    (value.modality === null || ["new", "improvement"].includes(String(value.modality))) &&
    (value.targetProjectId === null || typeof value.targetProjectId === "string") &&
    ["title", "summary", "description", "firstVersion", "promptVersion", "model"].every((key) => typeof value[key] === "string") &&
    (value.title as string).length <= 200 &&
    (value.summary as string).length <= 600 &&
    (value.description as string).length <= 3000 &&
    (value.firstVersion as string).length <= 2000 &&
    Array.isArray(value.terms) &&
    value.terms.every((term) =>
      isObject(term) &&
      typeof term.name === "string" &&
      term.name.length <= 80 &&
      typeof term.explanation === "string" &&
      term.explanation.length <= 500,
    ) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) =>
      isObject(reason) &&
      typeof reason.text === "string" &&
      Array.isArray(reason.evidenceIds) &&
      stringArray(reason.evidenceIds) &&
      typeof reason.inferred === "boolean",
    ) &&
    Array.isArray(value.stack) &&
    value.stack.every((item) =>
      isObject(item) &&
      typeof item.name === "string" &&
      typeof item.justification === "string",
    ) &&
    stringArray(value.limitations) &&
    validEffort &&
    validRating &&
    Array.isArray(value.citedEvidence) &&
    value.citedEvidence.every((item) =>
      isObject(item) &&
      typeof item.id === "string" &&
      typeof item.label === "string" &&
      typeof item.excerpt === "string" &&
      (item.sourceVersionId === undefined ||
        typeof item.sourceVersionId === "string") &&
      (item.sha256 === undefined ||
        (typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256))),
    ) &&
    typeof value.contextRevoked === "boolean" &&
    validTimestamp(value.createdAt)
  );
}

function articleReferencesKnownContent(article: JsonObject, ids: Set<string>) {
  const origin = article.origin;
  return (
    !isObject(origin) ||
    origin.kind !== "item" ||
    (typeof origin.contentId === "string" && ids.has(origin.contentId))
  );
}
function validateBackupReferences(backup: BackupFile) {
  const content = backup.contentDiscovery.content;
  ensureUnique(content, (row) => row.id, "content.id");
  ensureUnique(content, (row) => row.url, "content.url");
  ensureUnique(backup.contentDiscovery.settings, (row) => row.key, "settings.key");
  ensureUnique(backup.contentDiscovery.feedback, (row) => String(row.id), "feedback.id");
  ensureUnique(
    backup.contentDiscovery.mediumArchiveSignals,
    (row) => `${row.content_id}:${row.signal}`,
    "mediumArchiveSignals",
  );

  const contentIds = new Set(content.map((row) => row.id));
  for (const row of content) {
    if (backup.formatVersion < 2) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeUrl(row.url);
    } catch {
      throw new BackupFormatError(`Invalid article URL for ${row.id}.`);
    }
    const data = row.data;
    const occurrences = data.sourceOccurrences;
    if (
      data.id !== row.id ||
      data.canonicalUrl !== canonicalUrl ||
      row.url !== canonicalUrl ||
      typeof data.title !== "string" ||
      !data.title.trim() ||
      !Array.isArray(data.tags) ||
      data.tags.some((tag) => typeof tag !== "string") ||
      !Array.isArray(occurrences) ||
      occurrences.length === 0 ||
      occurrences.some(
        (entry) =>
          !isObject(entry) ||
          !["devto", "medium", "rss"].includes(String(entry.source)) ||
          typeof entry.originalUrl !== "string" ||
          !entry.originalUrl,
      )
    )
      throw new BackupFormatError(`Article ${row.id} does not match the current schema.`);
  }
  for (const row of backup.contentDiscovery.feedback)
    if (
      !contentIds.has(row.content_id) ||
      !VALID_FEEDBACK_ACTIONS.has(row.action) ||
      Number.isNaN(Date.parse(row.created_at)) ||
      (row.action === "rate"
        ? row.value !== "useful" && row.value !== "not_useful"
        : row.value !== null)
    )
      throw new BackupFormatError("Feedback is invalid or refers to a missing article.");
  for (const row of backup.contentDiscovery.mediumArchiveSignals)
    if (
      !contentIds.has(row.content_id) ||
      !["bookmark", "clap", "list"].includes(row.signal)
    )
      throw new BackupFormatError("A Medium signal refers to a missing article or is invalid.");

  validateProfileSettings(backup.contentDiscovery.settings);
  const context = backup.projectContext;
  if (!context) return;
  ensureUnique(context.config, (row) => row.key, "projectContext.config");
  for (const table of CONTEXT_TABLES) {
    const tableRows = context.tables[table];
    ensureUnique(tableRows, (row) => row.id, `projectContext.${table}`);
    for (const row of tableRows)
      if (
        !validTimestamp(row.created_at) ||
        (row.data.id !== undefined && row.data.id !== row.id)
      )
        throw new BackupFormatError(`Entity ID mismatch in ${table}.`);
  }
  const operations = context.tables.operations;
  const operationIds = new Set(operations.map((row) => row.id));
  const validStates = new Set<OperationState>([
    "created",
    "acquiring_article",
    "awaiting_article_text",
    "retrieving_context",
    "awaiting_consent",
    "generating",
    "validating",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ]);
  for (const row of operations)
    if (
      row.data.id !== row.id ||
      !validStates.has(row.data.state as OperationState) ||
      !["portfolio", "practical", "both"].includes(String(row.data.purpose)) ||
      !["full", "article_only"].includes(String(row.data.contextMode)) ||
      !Number.isInteger(row.data.attempt) ||
      (row.data.attempt as number) < 1 ||
      typeof row.data.projectsConsulted !== "boolean" ||
      (row.data.selectedProjectIds !== null && !stringArray(row.data.selectedProjectIds)) ||
      (row.data.article !== null && !validArticleSnapshot(row.data.article)) ||
      (isObject(row.data.article) &&
        !articleReferencesKnownContent(row.data.article, contentIds)) ||
      (row.data.contentId !== null &&
        (typeof row.data.contentId !== "string" ||
          !contentIds.has(row.data.contentId))) ||
      !validTimestamp(row.data.createdAt) ||
      !validTimestamp(row.data.updatedAt) ||
      (row.ref !== null && !operationIds.has(row.ref))
    )
      throw new BackupFormatError("An operation is malformed or references a missing operation.");
  for (const row of context.tables.articles)
    if (
      !validArticleSnapshot(row.data) ||
      row.data.id !== row.id ||
      !articleReferencesKnownContent(row.data, contentIds)
    )
      throw new BackupFormatError("An article snapshot is malformed.");
  for (const row of context.tables.recommendations)
    if (!validRecommendation(row.data) || row.data.id !== row.id)
      throw new BackupFormatError("A recommendation is malformed.");
  for (const row of context.tables.ignored_sources)
    if (
      row.data.id !== row.id ||
      !["file", "memory"].includes(String(row.data.kind)) ||
      typeof row.data.label !== "string" ||
      !validTimestamp(row.data.createdAt)
    )
      throw new BackupFormatError("An ignored-source record is malformed.");
  for (const row of context.tables.saved_theme_ideas)
    if (
      row.data.id !== row.id ||
      typeof row.data.searchId !== "string" ||
      typeof row.data.query !== "string" ||
      typeof row.data.title !== "string" ||
      typeof row.data.summary !== "string" ||
      typeof row.data.application !== "string" ||
      !stringArray(row.data.supportingArticleIds) ||
      row.data.supportingArticleIds.some((id) => !contentIds.has(id)) ||
      !validTimestamp(row.data.createdAt)
    )
      throw new BackupFormatError("A saved theme idea is malformed.");
  for (const table of ["articles", "recommendations", "evaluations"] as const)
    for (const row of context.tables[table])
      if (row.ref === null || !operationIds.has(row.ref))
        throw new BackupFormatError(`${table} references a missing operation.`);
  for (const row of context.tables.recommendations)
    if (row.data.operationId !== row.ref)
      throw new BackupFormatError("A recommendation references a different operation.");
  for (const row of context.tables.evaluations)
    if (
      row.data.id !== row.id ||
      (row.data.contentId !== null && typeof row.data.contentId !== "string") ||
      !["context_first", "plain_first"].includes(String(row.data.order)) ||
      (row.data.preference !== null &&
        !["context", "plain", "tie"].includes(String(row.data.preference))) ||
      !validTimestamp(row.data.createdAt) ||
      (row.data.decidedAt !== null && !validTimestamp(row.data.decidedAt)) ||
      !operationIds.has(String(row.data.contextOperationId)) ||
      !operationIds.has(String(row.data.plainOperationId))
    )
      throw new BackupFormatError("An evaluation references a missing operation.");

  ensureUnique(
    context.memoryRevisions,
    (row) => `${row.memory_id}:${row.revision}`,
    "memoryRevisions",
  );
  for (const row of context.memoryRevisions)
    if (
      row.data.memoryId !== row.memory_id ||
      row.data.revision !== row.revision ||
      row.data.state !== row.state ||
      !["pending", "confirmed", "discarded", "conflicted", "superseded", "revoked"].includes(row.state) ||
      !["goal", "preference", "experience", "constraint", "project_context", "knowledge"].includes(String(row.data.kind)) ||
      !["user_declared", "interest_profile", "proposal"].includes(String(row.data.origin)) ||
      typeof row.data.text !== "string" ||
      row.data.text.length < 3 ||
      row.data.text.length > 1200 ||
      !stringArray(row.data.references) ||
      !validTimestamp(row.data.proposedAt) ||
      (row.data.approvedAt !== null && !validTimestamp(row.data.approvedAt)) ||
      (row.data.revokedAt !== null && !validTimestamp(row.data.revokedAt))
    )
      throw new BackupFormatError("A memory revision is malformed.");
  ensureUnique(context.memoryTombstones, (row) => row.memory_id, "memoryTombstones");
  for (const row of context.memoryTombstones)
    if (Number.isNaN(Date.parse(row.forgotten_at)))
      throw new BackupFormatError("A memory tombstone has an invalid timestamp.");
}
export function parseBackup(text: string): BackupFile {
  if (Buffer.byteLength(text, "utf8") > MAX_BACKUP_BYTES)
    throw new BackupFormatError("Backup exceeds the 100 MiB import limit.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupFormatError(
      "Este arquivo não é um backup do Loounp: o conteúdo não é JSON válido.",
    );
  }
  if (!isObject(raw) || raw.format !== FORMAT)
    throw new BackupFormatError("Este arquivo não é um backup do Loounp.");
  if (!isInteger(raw.formatVersion) || raw.formatVersion < 1)
    throw new BackupFormatError("Backup inválido: versão de formato ausente.");
  if (raw.formatVersion > FORMAT_VERSION)
    throw new BackupFormatError(
      "Este backup foi criado por uma versão mais nova do Loounp e não pode ser importado aqui.",
    );
  if (!isString(raw.exportedAt) || !isString(raw.appVersion))
    throw new BackupFormatError("Backup inválido: metadados ausentes.");
  const discovery = raw.contentDiscovery;
  if (!isObject(discovery))
    throw new BackupFormatError(
      'Backup inválido: a seção "contentDiscovery" está ausente.',
    );
  const contentDiscovery = {
    content: rows<ContentRow>(
      discovery.content,
      "content",
      (row) =>
        isString(row.id) &&
        isString(row.url) &&
        isString(row.source) &&
        isObject(row.data),
    ).map((row) => ({
      ...row,
      url: redactCredentialUrl(row.url),
      data: redactCredentialUrls(row.data) as JsonObject,
    })),
    feedback: rows<FeedbackRow>(
      discovery.feedback,
      "feedback",
      (row) =>
        isInteger(row.id) &&
        isString(row.content_id) &&
        isString(row.action) &&
        isNullableString(row.value) &&
        isString(row.created_at),
    ),
    mediumArchiveSignals: rows<SignalRow>(
      discovery.mediumArchiveSignals,
      "mediumArchiveSignals",
      (row) => isString(row.content_id) && isString(row.signal),
    ),
    settings: rows<SettingRow>(discovery.settings, "settings", settingRow).map(
      (row) => ({ ...row, value: redactCredentialUrls(row.value) as string }),
    ),
  };
  let projectContext: BackupFile["projectContext"] = null;
  if (raw.projectContext !== null) {
    const context = raw.projectContext;
    if (!isObject(context))
      throw new BackupFormatError(
        'Backup inválido: a seção "projectContext" está malformada.',
      );
    if (!isInteger(context.schemaVersion))
      throw new BackupFormatError(
        "Backup inválido: versão do banco de ideias ausente.",
      );
    if (context.schemaVersion > SCHEMA_VERSION)
      throw new BackupFormatError(
        "Este backup foi criado por uma versão mais nova do Loounp e não pode ser importado aqui.",
      );
    if (!isObject(context.tables))
      throw new BackupFormatError(
        'Backup inválido: a seção "projectContext.tables" está ausente.',
      );
    const tables = context.tables;
    projectContext = {
      schemaVersion: context.schemaVersion,
      config: rows<SettingRow>(context.config, "config", settingRow).map(
        (row) => ({ ...row, value: redactCredentialUrls(row.value) as string }),
      ),
      tables: Object.fromEntries(
        CONTEXT_TABLES.map((table) => [
          table,
          rows<EntityRow>(tables[table] ?? [], table, entityRow).map((row) => ({
            ...row,
            data: redactCredentialUrls(row.data) as JsonObject,
          })),
        ]),
      ) as Record<ContextTable, EntityRow[]>,
      memoryRevisions: rows<MemoryRevisionRow>(
        context.memoryRevisions,
        "memoryRevisions",
        (row) =>
          isString(row.memory_id) &&
          isInteger(row.revision) &&
          isString(row.state) &&
          isObject(row.data),
      ).map((row) => ({
        ...row,
        data: redactCredentialUrls(row.data) as JsonObject,
      })),
      memoryTombstones: rows<MemoryTombstoneRow>(
        context.memoryTombstones,
        "memoryTombstones",
        (row) => isString(row.memory_id) && isString(row.forgotten_at),
      ),
    };
  }
  const backup: BackupFile = {
    format: FORMAT,
    formatVersion: raw.formatVersion,
    exportedAt: raw.exportedAt,
    appVersion: raw.appVersion,
    contentDiscovery,
    projectContext,
  };
  validateBackupReferences(backup);
  return backup;
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function replaceContentTables(
  run: (sql: string, params?: unknown[]) => void,
  data: BackupFile["contentDiscovery"],
) {
  run("DELETE FROM content");
  for (const row of data.content)
    run("INSERT INTO content(id, url, source, data) VALUES (?, ?, ?, ?)", [
      row.id,
      row.url,
      row.source,
      JSON.stringify(row.data),
    ]);
  run("DELETE FROM feedback");
  for (const row of data.feedback)
    run(
      "INSERT INTO feedback(id, content_id, action, value, created_at) VALUES (?, ?, ?, ?, ?)",
      [row.id, row.content_id, row.action, row.value, row.created_at],
    );
  run("DELETE FROM medium_archive_signals");
  for (const row of data.mediumArchiveSignals)
    run(
      "INSERT INTO medium_archive_signals(content_id, signal) VALUES (?, ?)",
      [row.content_id, row.signal],
    );
  const secrets = [...SECRET_SETTING_KEYS];
  run(
    `DELETE FROM settings WHERE key NOT IN (${secrets.map(() => "?").join(", ")})`,
    secrets,
  );
  for (const row of data.settings)
    if (!SECRET_SETTING_KEYS.has(row.key))
      run("INSERT INTO settings(key, value) VALUES (?, ?)", [
        row.key,
        row.value,
      ]);
}

function normalizeOperation(row: EntityRow, at: string): EntityRow {
  const state = row.data.state as OperationState;
  if (terminalStates.has(state)) return row;
  return {
    ...row,
    data: {
      ...row.data,
      state: "interrupted",
      error: interruptedMessage,
      updatedAt: at,
    },
  };
}

export async function applyBackup(
  backup: BackupFile,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const context = backup.projectContext;
  if (context && !deps.context)
    throw new BackupFormatError(
      "A exploração de ideias está indisponível; não é possível importar ideias e memória agora.",
    );
  const store = context ? deps.context : null;
  const now = deps.now();
  const stamp = timestamp(now);
  const contentFile = deps.content.databaseFile();
  const contentBytes = await deps.readFile(contentFile);
  const contextBytes = store ? await deps.readFile(store.databaseFile) : null;
  const backups = [`${contentFile}.${stamp}.bak`];
  await deps.writeFile(backups[0], contentBytes);
  if (store && contextBytes) {
    backups.push(`${store.databaseFile}.${stamp}.bak`);
    await deps.writeFile(backups[1], contextBytes);
  }

  const snapshot = deps.content.exportBytes();
  deps.content.transaction((run) =>
    replaceContentTables(run, backup.contentDiscovery),
  );

  if (store && context) {
    const at = now.toISOString();
    const raw = (row: EntityRow) => ({
      ...row,
      data: JSON.stringify(row.data),
    });
    try {
      await store.mutate((tx) => {
        for (const table of CONTEXT_TABLES) {
          const source =
            table === "operations"
              ? context.tables[table].map((row) => normalizeOperation(row, at))
              : context.tables[table];
          tx.replaceRaw(table, source.map(raw));
        }
        for (const table of CLEARED_ON_IMPORT) tx.clear(table);
        tx.replaceMemory(
          context.memoryRevisions.map((row) => ({
            ...row,
            data: JSON.stringify(row.data),
          })),
          context.memoryTombstones,
        );
        tx.replaceConfig(context.config as RawConfigRow[], LOCAL_CONFIG_KEYS);
      });
    } catch (error) {
      deps.content.restoreBytes(snapshot);
      throw error;
    }
  }

  try {
    await deps.content.persist();
  } catch (error) {
    deps.content.restoreBytes(snapshot);
    if (store && contextBytes) await store.replaceDatabase(contextBytes);
    throw error;
  }
  return { backups, counts: summarize(backup) };
}
