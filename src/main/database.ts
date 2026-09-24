import { app } from 'electron'
import initSqlJs, { type Database as SqlDatabase } from 'sql.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let database: SqlDatabase
let databasePath: string

export async function openDatabase(): Promise<void> {
  databasePath = join(app.getPath('userData'), 'content-discovery.sqlite')
  await mkdir(dirname(databasePath), { recursive: true })
  const SQL = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) })
  try {
    database = new SQL.Database(new Uint8Array(await readFile(databasePath)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    database = new SQL.Database()
  }
  database.run(`CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, data TEXT NOT NULL)`)
  database.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  database.run(`CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, content_id TEXT NOT NULL, action TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)`)
  database.run(`CREATE TABLE IF NOT EXISTS medium_archive_signals (content_id TEXT NOT NULL, signal TEXT NOT NULL, PRIMARY KEY(content_id, signal))`)
  await persist()
}

export async function persist(): Promise<void> {
  await writeFile(databasePath, Buffer.from(database.export()))
}

export function all<T>(sql: string, params: unknown[] = []): T[] {
  const statement = database.prepare(sql)
  try {
    statement.bind(params as (string | number | null | Uint8Array)[])
    const rows: T[] = []
    while (statement.step()) rows.push(statement.getAsObject() as T)
    return rows
  } finally {
    statement.free()
  }
}

export function run(sql: string, params: unknown[] = []): void {
  database.run(sql, params as (string | number | null | Uint8Array)[])
}

export function getSetting(key: string): string | null {
  return all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])[0]?.value ?? null
}

export function setSetting(key: string, value: string): void {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
}
