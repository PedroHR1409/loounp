import { app } from "electron";
import initSqlJs, {
  type Database as SqlDatabase,
  type SqlJsStatic,
} from "sql.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { atomicWrite } from "./project-context-store";

const require = createRequire(import.meta.url);
let SQL: SqlJsStatic;
let database: SqlDatabase;
let databasePath: string;

export type ContentTable =
  "content" | "feedback" | "medium_archive_signals" | "settings";
type SqlParams = (string | number | null | Uint8Array)[];

export async function openDatabase(
  baseDirectory: string = app.getPath("userData"),
): Promise<void> {
  databasePath = join(baseDirectory, "content-discovery.sqlite");
  await mkdir(dirname(databasePath), { recursive: true });
  SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  try {
    database = new SQL.Database(new Uint8Array(await readFile(databasePath)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    database = new SQL.Database();
  }
  database.run(
    `CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, data TEXT NOT NULL)`,
  );
  database.run(
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  database.run(
    `CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, content_id TEXT NOT NULL, action TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)`,
  );
  database.run(
    `CREATE TABLE IF NOT EXISTS medium_archive_signals (content_id TEXT NOT NULL, signal TEXT NOT NULL, PRIMARY KEY(content_id, signal))`,
  );
  await persist();
}

export async function persist(): Promise<void> {
  await atomicWrite(databasePath, database.export());
}

export function databaseFile(): string {
  return databasePath;
}

export function all<T>(sql: string, params: unknown[] = []): T[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(params as SqlParams);
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as T);
    return rows;
  } finally {
    statement.free();
  }
}

export function run(sql: string, params: unknown[] = []): void {
  database.run(sql, params as SqlParams);
}

export function dumpTable<T>(table: ContentTable): T[] {
  return all<T>(`SELECT * FROM ${table}`);
}

export function transaction(
  fn: (run: (sql: string, params?: unknown[]) => void) => void,
): void {
  database.run("BEGIN");
  try {
    fn((sql, params = []) => database.run(sql, params as SqlParams));
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

export function exportBytes(): Uint8Array {
  return database.export();
}

export function restoreBytes(bytes: Uint8Array): void {
  database.close();
  database = new SQL.Database(bytes);
}

export function getSetting(key: string): string | null {
  return (
    all<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key])[0]
      ?.value ?? null
  );
}

export function setSetting(key: string, value: string): void {
  run(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}
