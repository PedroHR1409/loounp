import initSqlJs, {
  type Database as SqlDatabase,
  type SqlJsStatic,
} from "sql.js";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  limits,
  type ArticleSnapshot,
  type Consent,
  type ContextPackage,
  type Evaluation,
  type Evidence,
  type IgnoredSource,
  type Purpose,
  type ModelConfig,
  type Operation,
  type Project,
  type Recommendation,
  type SourceVersion,
} from "../core/project-ideas";
import type {
  MemoryLedger,
  MemoryRevision,
  MemoryTombstone,
} from "../core/personal-memory";

const require = createRequire(import.meta.url);
export const SCHEMA_VERSION = 1;
export const DEFAULT_PROTECTED_ROOT = join(homedir(), "Desktop", "Projetos");
const DAY = 86_400_000;

const entityTables = [
  "operations",
  "articles",
  "projects",
  "source_versions",
  "evidence",
  "context_packages",
  "consents",
  "recommendations",
  "audit",
  "evaluations",
  "ignored_sources",
] as const;
type EntityTable = (typeof entityTables)[number];
type EntityMap = {
  operations: Operation;
  articles: ArticleSnapshot;
  projects: Project;
  source_versions: SourceVersion;
  evidence: Evidence;
  context_packages: ContextPackage;
  consents: Consent;
  recommendations: Recommendation;
  audit: AuditEntry;
  evaluations: Evaluation;
  ignored_sources: IgnoredSource;
};
export type AuditEntry = {
  id: string;
  operationId: string;
  event:
    | "consent_confirmed"
    | "consent_denied"
    | "consent_invalidated"
    | "call_sent"
    | "call_discarded"
    | "memory_forgotten"
    | "context_removed";
  payloadSha256: string | null;
  itemIds: string[];
  at: string;
};

export class StoreLocationError extends Error {}
export class SchemaVersionError extends Error {}

function normalizeForCompare(path: string) {
  const resolved = resolve(path);
  return (
    process.platform === "win32" ? resolved.toLowerCase() : resolved
  ).replace(/[\\/]+$/, "");
}

export function isInside(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  return c === p || c.startsWith(p + sep) || c.startsWith(p + "/");
}

export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const pending: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...pending.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    pending.push(current.slice(parent.length).replace(/^[\\/]/, ""));
    current = parent;
  }
}

export async function assertSafeExternalPath(
  path: string,
  protectedRoot: string,
): Promise<string> {
  const absolute = resolve(path);
  const canonical = await canonicalPath(absolute);
  const roots = [protectedRoot, await canonicalPath(protectedRoot)];
  if (
    roots.some((root) => isInside(absolute, root) || isInside(canonical, root))
  )
    throw new StoreLocationError(
      `O local ${canonical} está dentro da pasta protegida de projetos. Configure um local externo.`,
    );
  let current = absolute;
  const root = parse(absolute).root;
  while (current && current !== root) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new StoreLocationError(
          `O caminho ${current} é um redirecionamento (link ou junction) e foi recusado.`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
  return absolute;
}

export async function atomicWrite(
  path: string,
  data: Uint8Array | string,
): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, data, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

let sqlModule: Promise<SqlJsStatic> | undefined;
function loadSql() {
  sqlModule ??= initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  return sqlModule;
}

export class ProjectContextStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private database: SqlDatabase,
    private readonly SQL: SqlJsStatic,
    readonly directory: string,
    private readonly databasePath: string,
    readonly protectedRoot: string,
  ) {}

  static async open(options: {
    baseDirectory: string;
    protectedRoot?: string;
  }): Promise<ProjectContextStore> {
    const protectedRoot = options.protectedRoot ?? DEFAULT_PROTECTED_ROOT;
    const directory = await assertSafeExternalPath(
      join(options.baseDirectory, "article-to-project"),
      protectedRoot,
    );
    await mkdir(join(directory, "index"), { recursive: true });
    await assertSafeExternalPath(join(directory, "index"), protectedRoot);
    const databasePath = join(directory, "project-context.sqlite");
    const SQL = await loadSql();
    let database: SqlDatabase;
    try {
      database = new SQL.Database(new Uint8Array(await readFile(databasePath)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      database = new SQL.Database();
    }
    const store = new ProjectContextStore(
      database,
      SQL,
      directory,
      databasePath,
      protectedRoot,
    );
    store.migrate();
    await store.flush();
    return store;
  }

  private migrate() {
    this.database.run(
      "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const version = Number(this.getConfig("schema_version") ?? "0");
    if (version > SCHEMA_VERSION)
      throw new SchemaVersionError(
        "O banco desta funcionalidade foi criado por uma versão mais nova do aplicativo e não será sobrescrito.",
      );
    for (const table of entityTables)
      this.database.run(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, ref TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL)`,
      );
    this.database.run(
      "CREATE TABLE IF NOT EXISTS memory_revisions (memory_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(memory_id, revision))",
    );
    this.database.run(
      "CREATE TABLE IF NOT EXISTS memory_tombstones (memory_id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL)",
    );
    this.database.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS recommendation_operation ON recommendations(ref)",
    );
    this.database.run(
      "INSERT OR REPLACE INTO config(key, value) VALUES ('schema_version', ?)",
      [String(SCHEMA_VERSION)],
    );
  }

  private async flush() {
    await atomicWrite(this.databasePath, this.database.export());
  }

  mutate<T>(mutation: (tx: StoreTransaction) => T): Promise<T> {
    const run = async () => {
      const snapshot = this.database.export();
      let result: T;
      try {
        this.database.run("BEGIN");
        result = mutation(new StoreTransaction(this.database));
        this.database.run("COMMIT");
      } catch (error) {
        try {
          this.database.run("ROLLBACK");
        } catch {
          this.restore(snapshot);
        }
        throw error;
      }
      try {
        await this.flush();
      } catch (error) {
        this.restore(snapshot);
        throw new Error(
          `Falha ao salvar o contexto local; a versão anterior foi preservada. ${String(error)}`,
        );
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private restore(snapshot: Uint8Array) {
    this.database.close();
    this.database = new this.SQL.Database(snapshot);
  }

  private rows<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  getConfig(key: string): string | null {
    return (
      this.rows<{ value: string }>("SELECT value FROM config WHERE key = ?", [
        key,
      ])[0]?.value ?? null
    );
  }

  get<K extends EntityTable>(table: K, id: string): EntityMap[K] | null {
    const row = this.rows<{ data: string }>(
      `SELECT data FROM ${table} WHERE id = ?`,
      [id],
    )[0];
    return row ? (JSON.parse(row.data) as EntityMap[K]) : null;
  }

  list<K extends EntityTable>(table: K, ref?: string): EntityMap[K][] {
    const rows =
      ref === undefined
        ? this.rows<{ data: string }>(
            `SELECT data FROM ${table} ORDER BY created_at`,
          )
        : this.rows<{ data: string }>(
            `SELECT data FROM ${table} WHERE ref = ? ORDER BY created_at`,
            [ref],
          );
    return rows.map((row) => JSON.parse(row.data) as EntityMap[K]);
  }

  ledger(): MemoryLedger {
    return {
      globalRevision: Number(this.getConfig("memory_global_revision") ?? "0"),
      revisions: this.rows<{ data: string }>(
        "SELECT data FROM memory_revisions ORDER BY memory_id, revision",
      ).map((row) => JSON.parse(row.data) as MemoryRevision),
      tombstones: this.rows<{ memory_id: string; forgotten_at: string }>(
        "SELECT memory_id, forgotten_at FROM memory_tombstones",
      ).map((row): MemoryTombstone => ({
        memoryId: row.memory_id,
        forgottenAt: row.forgotten_at,
      })),
    };
  }

  modelConfig(): ModelConfig {
    const stored = this.getConfig("model_config");
    if (stored)
      try {
        return JSON.parse(stored) as ModelConfig;
      } catch {
        /* fall back to defaults */
      }
    return { provider: "openai", model: "gpt-5.6-luna", contextTokens: null };
  }

  lastPurpose(): Purpose {
    const value = this.getConfig("last_purpose");
    return value === "portfolio" || value === "practical" || value === "both"
      ? value
      : "both";
  }

  ignoredPaths(): Set<string> {
    return new Set(
      this.list("ignored_sources")
        .filter((item) => item.kind === "file" && item.relativePath)
        .map((item) => item.relativePath!),
    );
  }

  ignoredMemories(): Set<string> {
    return new Set(
      this.list("ignored_sources")
        .filter((item) => item.kind === "memory" && item.memoryId)
        .map((item) => item.memoryId!),
    );
  }

  graphExpansionEnabled(): boolean {
    return this.getConfig("graph_expansion") === "true";
  }

  realSourcesEnabled(): boolean {
    return this.getConfig("real_sources_enabled") === "true";
  }

  indexPath(projectId: string): string {
    if (!/^prj_[A-Za-z0-9_-]{8,64}$/.test(projectId))
      throw new Error("Projeto inválido.");
    return join(this.directory, "index", `${projectId}.json`);
  }

  async writeIndex(projectId: string, data: unknown): Promise<void> {
    await atomicWrite(this.indexPath(projectId), JSON.stringify(data));
  }

  async readIndex<T>(projectId: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.indexPath(projectId), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async removeIndex(projectId: string): Promise<void> {
    await rm(this.indexPath(projectId), { force: true });
  }

  async applyRetention(
    now: Date,
  ): Promise<{ removedResults: number; removedIndexes: number }> {
    const at = now.getTime();
    const removed = await this.mutate((tx) => {
      let removedResults = 0;
      for (const recommendation of this.list("recommendations")) {
        if (
          at - Date.parse(recommendation.createdAt) >
          limits.retention.resultDays * DAY
        ) {
          tx.removeOperationData(recommendation.operationId);
          removedResults += 1;
        }
      }
      for (const entry of this.list("audit"))
        if (at - Date.parse(entry.at) > limits.retention.auditDays * DAY)
          tx.delete("audit", entry.id);
      for (const pkg of this.list("context_packages")) {
        const operation = this.get("operations", pkg.operationId);
        if (
          !operation ||
          ["completed", "failed", "canceled", "interrupted"].includes(
            operation.state,
          )
        )
          tx.delete("context_packages", pkg.id);
      }
      const cutoff = at - limits.retention.pendingMemoryDays * DAY;
      for (const revision of this.ledger().revisions)
        if (
          revision.state === "pending" &&
          Date.parse(revision.proposedAt) < cutoff
        )
          tx.putMemoryRevision({ ...revision, state: "discarded" });
      return removedResults;
    });
    const indexDir = join(this.directory, "index");
    const files = await Promise.all(
      (await readdir(indexDir))
        .filter((name) => /^prj_[A-Za-z0-9_-]+\.json$/.test(name))
        .map(async (name) => ({
          name,
          info: await stat(join(indexDir, name)),
        })),
    );
    let removedIndexes = 0;
    let total = files.reduce((sum, file) => sum + file.info.size, 0);
    for (const file of files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      if (
        at - file.info.mtimeMs > limits.retention.indexDays * DAY ||
        total > limits.retention.indexBytes
      ) {
        await rm(join(indexDir, file.name), { force: true });
        total -= file.info.size;
        removedIndexes += 1;
      }
    }
    return { removedResults: removed, removedIndexes };
  }
}

export class StoreTransaction {
  constructor(private readonly database: SqlDatabase) {}

  put<K extends EntityTable>(
    table: K,
    value: EntityMap[K] & { id: string },
    ref: string | null,
    createdAt: string,
  ): void {
    this.database.run(
      `INSERT INTO ${table}(id, ref, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ref = excluded.ref, data = excluded.data`,
      [value.id, ref, createdAt, JSON.stringify(value)],
    );
  }

  delete(table: EntityTable, id: string): void {
    this.database.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }

  deleteByRef(table: EntityTable, ref: string): void {
    this.database.run(`DELETE FROM ${table} WHERE ref = ?`, [ref]);
  }

  setConfig(key: string, value: string): void {
    this.database.run(
      "INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)",
      [key, value],
    );
  }

  putMemoryRevision(revision: MemoryRevision): void {
    this.database.run(
      "INSERT OR REPLACE INTO memory_revisions(memory_id, revision, state, data) VALUES (?, ?, ?, ?)",
      [
        revision.memoryId,
        revision.revision,
        revision.state,
        JSON.stringify(revision),
      ],
    );
  }

  writeLedger(ledger: MemoryLedger): void {
    this.database.run("DELETE FROM memory_revisions");
    for (const revision of ledger.revisions) this.putMemoryRevision(revision);
    for (const tombstone of ledger.tombstones)
      this.database.run(
        "INSERT OR IGNORE INTO memory_tombstones(memory_id, forgotten_at) VALUES (?, ?)",
        [tombstone.memoryId, tombstone.forgottenAt],
      );
    this.setConfig("memory_global_revision", String(ledger.globalRevision));
  }

  removeOperationData(operationId: string): void {
    for (const pkg of this.selectIds("context_packages", operationId))
      this.database.run("DELETE FROM consents WHERE ref = ?", [pkg]);
    this.deleteByRef("context_packages", operationId);
    this.deleteByRef("recommendations", operationId);
    this.deleteByRef("evaluations", operationId);
    this.deleteByRef("articles", operationId);
    this.delete("operations", operationId);
  }

  private selectIds(table: EntityTable, ref: string): string[] {
    const statement = this.database.prepare(
      `SELECT id FROM ${table} WHERE ref = ?`,
    );
    try {
      statement.bind([ref]);
      const ids: string[] = [];
      while (statement.step()) ids.push(String(statement.getAsObject().id));
      return ids;
    } finally {
      statement.free();
    }
  }
}
