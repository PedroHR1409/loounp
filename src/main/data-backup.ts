import { terminalStates, type OperationState } from "../core/project-ideas";
import {
  SCHEMA_VERSION,
  type EntityTable,
  type ProjectContextStore,
  type RawConfigRow,
} from "./project-context-store";

export const FORMAT = "loounp-backup";
export const FORMAT_VERSION = 1;
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "openai_key",
  "jev_key",
  "typesafe_jev_key",
]);
export const LOCAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "real_sources_enabled",
]);
export const CONTEXT_TABLES = [
  "operations",
  "articles",
  "recommendations",
  "evaluations",
  "ignored_sources",
] as const satisfies readonly EntityTable[];
export const CLEARED_ON_IMPORT = [
  "context_packages",
  "consents",
] as const satisfies readonly EntityTable[];

type ContextTable = (typeof CONTEXT_TABLES)[number];
type JsonObject = Record<string, unknown>;

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
    data: JSON.parse(row.data) as JsonObject,
  });
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: input.now().toISOString(),
    appVersion: input.appVersion,
    contentDiscovery: {
      content: content
        .dumpTable<{ id: string; url: string; source: string; data: string }>(
          "content",
        )
        .map(parse),
      feedback: content.dumpTable<FeedbackRow>("feedback"),
      mediumArchiveSignals: content.dumpTable<SignalRow>(
        "medium_archive_signals",
      ),
      settings: content
        .dumpTable<SettingRow>("settings")
        .filter((row) => !SECRET_SETTING_KEYS.has(row.key)),
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

export function parseBackup(text: string): BackupFile {
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
    ),
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
    settings: rows<SettingRow>(discovery.settings, "settings", settingRow),
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
      config: rows<SettingRow>(context.config, "config", settingRow),
      tables: Object.fromEntries(
        CONTEXT_TABLES.map((table) => [
          table,
          rows<EntityRow>(tables[table], table, entityRow),
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
      ),
      memoryTombstones: rows<MemoryTombstoneRow>(
        context.memoryTombstones,
        "memoryTombstones",
        (row) => isString(row.memory_id) && isString(row.forgotten_at),
      ),
    };
  }
  return {
    format: FORMAT,
    formatVersion: raw.formatVersion,
    exportedAt: raw.exportedAt,
    appVersion: raw.appVersion,
    contentDiscovery,
    projectContext,
  };
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
