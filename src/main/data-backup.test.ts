import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import initSqlJs, {
  type Database as SqlDatabase,
  type SqlJsStatic,
} from "sql.js";
import {
  applyBackup,
  BackupFormatError,
  buildBackup,
  CONTEXT_TABLES,
  parseBackup,
  summarize,
  type ApplyDeps,
  type ContentDbPort,
  type ContextStorePort,
} from "./data-backup";
import { atomicWrite, ProjectContextStore } from "./project-context-store";
import { confirm, emptyLedger, propose } from "../core/personal-memory";
import type { Operation } from "../core/project-ideas";

const require = createRequire(import.meta.url);
let SQL: SqlJsStatic;
let base: string;
let protectedRoot: string;

type ContentEnv = ContentDbPort & { db: () => SqlDatabase };

async function openContent(directory: string): Promise<ContentEnv> {
  SQL ??= await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  await mkdir(directory, { recursive: true });
  const file = join(directory, "content-discovery.sqlite");
  let db = new SQL.Database();
  db.run(
    "CREATE TABLE content (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, source TEXT NOT NULL, data TEXT NOT NULL)",
  );
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(
    "CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, content_id TEXT NOT NULL, action TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)",
  );
  db.run(
    "CREATE TABLE medium_archive_signals (content_id TEXT NOT NULL, signal TEXT NOT NULL, PRIMARY KEY(content_id, signal))",
  );
  const port: ContentEnv = {
    db: () => db,
    databaseFile: () => file,
    dumpTable: <T>(table: string) => {
      const statement = db.prepare(`SELECT * FROM ${table}`);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      statement.free();
      return rows;
    },
    transaction: (fn) => {
      db.run("BEGIN");
      try {
        fn((sql, params = []) => db.run(sql, params as never));
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },
    exportBytes: () => db.export(),
    restoreBytes: (bytes) => {
      db.close();
      db = new SQL.Database(bytes);
    },
    persist: () => atomicWrite(file, db.export()),
  };
  await port.persist();
  return port;
}

const operation = (
  id: string,
  state: Operation["state"] = "completed",
): Operation => ({
  id,
  state,
  article: null,
  contentId: "devto:1",
  purpose: "both",
  selectedProjectIds: null,
  projectsConsulted: true,
  attempt: 1,
  currentPackageId: null,
  contextMode: "full",
  comparisonOf: null,
  error: null,
  createdAt: "2026-09-23T12:00:00.000Z",
  updatedAt: "2026-09-23T12:00:00.000Z",
});
const at = "2026-09-23T12:00:00.000Z";

async function seedSource(content: ContentEnv, store: ProjectContextStore) {
  const db = content.db();
  db.run("INSERT INTO content VALUES (?, ?, ?, ?)", [
    "devto:1",
    "https://dev.to/a",
    "devto",
    JSON.stringify({ id: "devto:1", title: "RAG na prática", tags: ["ai"] }),
  ]);
  db.run("INSERT INTO content VALUES (?, ?, ?, ?)", [
    "medium:https://medium.com/b",
    "https://medium.com/b",
    "medium",
    JSON.stringify({ id: "medium:https://medium.com/b", title: "Lakehouse" }),
  ]);
  db.run(
    "INSERT INTO feedback(content_id, action, value, created_at) VALUES (?, ?, ?, ?)",
    ["devto:1", "rating", "useful", at],
  );
  db.run(
    "INSERT INTO feedback(content_id, action, value, created_at) VALUES (?, ?, ?, ?)",
    ["devto:1", "open", null, at],
  );
  db.run("INSERT INTO medium_archive_signals VALUES (?, ?)", [
    "medium-archive:abc",
    "clap",
  ]);
  db.run("INSERT INTO settings VALUES (?, ?)", [
    "profile_v2",
    JSON.stringify({ revision: 3, interestGroups: [] }),
  ]);
  db.run("INSERT INTO settings VALUES (?, ?)", ["ranking_mode", "reference"]);
  db.run("INSERT INTO settings VALUES (?, ?)", ["openai_key", "stored"]);
  db.run("INSERT INTO settings VALUES (?, ?)", ["typesafe_jev_key", "stored"]);
  await content.persist();
  const ledger = confirm(
    propose(
      emptyLedger(),
      {
        memoryId: "mem_00000001",
        kind: "goal",
        text: "Aprender RAG na prática",
        origin: "user_declared",
      },
      at,
    ),
    "mem_00000001",
    1,
    1,
    at,
  );
  await store.mutate((tx) => {
    tx.put("operations", operation("op_done0001"), null, at);
    tx.put(
      "operations",
      operation("op_live0001", "generating"),
      null,
      "2026-09-23T12:05:00.000Z",
    );
    tx.put(
      "articles",
      {
        id: "art_00000001",
        title: "RAG na prática",
        text: "texto completo",
      } as never,
      "op_done0001",
      at,
    );
    tx.put(
      "recommendations",
      {
        id: "rec_00000001",
        operationId: "op_done0001",
        title: "Ideia",
        citedEvidence: [
          {
            id: "ev_00000001",
            label: "src/app.ts",
            excerpt: "const segredoDeCodigo = 1",
          },
        ],
      } as never,
      "op_done0001",
      at,
    );
    tx.put(
      "ignored_sources",
      {
        id: "ign_00000001",
        kind: "file",
        relativePath: "notes.md",
        memoryId: null,
        label: "notes.md",
        createdAt: at,
      },
      null,
      at,
    );
    tx.put("projects", { id: "prj_sourceproject" } as never, null, at);
    tx.put(
      "evidence",
      { id: "ev_source000001", excerpt: "evidencia-local-origem" } as never,
      "prj_sourceproject",
      at,
    );
    tx.writeLedger(ledger);
    tx.setConfig("last_purpose", "portfolio");
    tx.setConfig("real_sources_enabled", "true");
  });
}

async function environment(name: string) {
  const directory = join(base, name);
  const content = await openContent(directory);
  const store = await ProjectContextStore.open({
    baseDirectory: directory,
    protectedRoot,
  });
  return { content, store };
}

const deps = (
  content: ContentDbPort,
  store: ContextStorePort | null,
  overrides: Partial<ApplyDeps> = {},
): ApplyDeps => ({
  content,
  context: store,
  now: () => new Date("2026-09-24T10:11:12"),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  writeFile: atomicWrite,
  ...overrides,
});

const contentState = (content: ContentDbPort) => ({
  content: content.dumpTable("content"),
  feedback: content.dumpTable("feedback"),
  signals: content.dumpTable("medium_archive_signals"),
  settings: content.dumpTable("settings"),
});
const contextState = (store: ProjectContextStore) => ({
  tables: Object.fromEntries(
    CONTEXT_TABLES.map((table) => [table, store.dumpRaw(table)]),
  ),
  memory: store.dumpMemory(),
  config: store.dumpConfig(),
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "loounp-backup-"));
  protectedRoot = join(base, "Projetos");
  await mkdir(protectedRoot);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("data backup", () => {
  it("round-trips every in-scope table between two machines (AT-001, AT-003)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const text = JSON.stringify(
      buildBackup({
        content: source.content,
        context: source.store,
        now: () => new Date(at),
        appVersion: "0.1.0",
      }),
      null,
      2,
    );
    const target = await environment("target");
    await applyBackup(parseBackup(text), deps(target.content, target.store));

    const expectedSettings = source.content
      .dumpTable<{ key: string }>("settings")
      .filter((row) => !["openai_key", "typesafe_jev_key"].includes(row.key));
    expect(target.content.dumpTable("content")).toEqual(
      source.content.dumpTable("content"),
    );
    expect(target.content.dumpTable("feedback")).toEqual(
      source.content.dumpTable("feedback"),
    );
    expect(target.content.dumpTable("medium_archive_signals")).toEqual(
      source.content.dumpTable("medium_archive_signals"),
    );
    expect(target.content.dumpTable("settings")).toEqual(expectedSettings);
    for (const table of [
      "articles",
      "recommendations",
      "evaluations",
      "ignored_sources",
    ] as const)
      expect(target.store.dumpRaw(table)).toEqual(source.store.dumpRaw(table));
    expect(target.store.dumpMemory()).toEqual(source.store.dumpMemory());
    expect(target.store.getConfig("last_purpose")).toBe("portfolio");
    expect(target.store.getConfig("memory_global_revision")).toBe("1");
    expect(target.store.get("recommendations", "rec_00000001")).toMatchObject({
      citedEvidence: [
        { id: "ev_00000001", excerpt: "const segredoDeCodigo = 1" },
      ],
    });

    const reopened = await ProjectContextStore.open({
      baseDirectory: join(base, "target"),
      protectedRoot,
    });
    expect(reopened.ledger().revisions[0]).toMatchObject({
      text: "Aprender RAG na prática",
    });
    const persisted = new SQL.Database(
      new Uint8Array(await readFile(target.content.databaseFile())),
    );
    expect(persisted.exec("SELECT COUNT(*) FROM content")[0].values[0][0]).toBe(
      2,
    );
  });

  it("never writes key markers, evidence, source versions or projects to the file (AT-002)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const backup = buildBackup({
      content: source.content,
      context: source.store,
      now: () => new Date(at),
      appVersion: "0.1.0",
    });
    const text = JSON.stringify(backup);
    for (const forbidden of [
      "openai_key",
      "jev_key",
      "real_sources_enabled",
      "schema_version",
      "prj_sourceproject",
      "evidencia-local-origem",
    ])
      expect(text).not.toContain(forbidden);
    expect(Object.keys(backup.projectContext!.tables).sort()).toEqual(
      [...CONTEXT_TABLES].sort(),
    );
    expect(summarize(backup)).toMatchObject({
      articles: 2,
      feedback: 2,
      mediumSignals: 1,
      ideas: 1,
      capturedArticles: 1,
      memories: 1,
      projectContextIncluded: true,
    });
  });

  it("rejects files that are not valid backups of this or an older version (AT-006, AT-007)", () => {
    const valid = {
      format: "loounp-backup",
      formatVersion: 1,
      exportedAt: at,
      appVersion: "0.1.0",
      contentDiscovery: {
        content: [],
        feedback: [],
        mediumArchiveSignals: [],
        settings: [],
      },
      projectContext: null,
    };
    expect(parseBackup(JSON.stringify(valid)).projectContext).toBeNull();
    expect(() => parseBackup("{not json")).toThrow(BackupFormatError);
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, format: "other-app" })),
    ).toThrow("não é um backup do Loounp");
    expect(() =>
      parseBackup(JSON.stringify({ ...valid, formatVersion: 2 })),
    ).toThrow("versão mais nova");
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...valid,
          projectContext: {
            schemaVersion: 99,
            config: [],
            tables: {},
            memoryRevisions: [],
            memoryTombstones: [],
          },
        }),
      ),
    ).toThrow("versão mais nova");
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...valid,
          contentDiscovery: { ...valid.contentDiscovery, content: [{ id: 1 }] },
        }),
      ),
    ).toThrow('seção "content"');
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...valid,
          contentDiscovery: { ...valid.contentDiscovery, feedback: undefined },
        }),
      ),
    ).toThrow('seção "feedback"');
  });

  it("writes one .bak per database with the previous bytes before replacing (AT-004)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const target = await environment("target");
    target.content
      .db()
      .run("INSERT INTO settings VALUES (?, ?)", ["ranking_mode", "jev"]);
    await target.content.persist();
    const beforeContent = await readFile(target.content.databaseFile());
    const beforeContext = await readFile(target.store.databaseFile);
    const result = await applyBackup(
      buildBackup({
        content: source.content,
        context: source.store,
        now: () => new Date(at),
        appVersion: "0.1.0",
      }),
      deps(target.content, target.store),
    );

    expect(result.backups).toEqual([
      `${target.content.databaseFile()}.20260924-101112.bak`,
      `${target.store.databaseFile}.20260924-101112.bak`,
    ]);
    expect(await readFile(result.backups[0])).toEqual(beforeContent);
    expect(await readFile(result.backups[1])).toEqual(beforeContext);
    const baks = [
      ...(await readdir(join(base, "target"))),
      ...(await readdir(join(base, "target", "article-to-project"))),
    ].filter((name) => name.endsWith(".bak"));
    expect(baks).toHaveLength(2);
  });

  it("restores both databases when saving the content database fails (AT-008)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const target = await environment("target");
    target.content
      .db()
      .run("INSERT INTO settings VALUES (?, ?)", ["ranking_mode", "jev"]);
    await target.content.persist();
    await target.store.mutate((tx) =>
      tx.setConfig("last_purpose", "practical"),
    );
    const beforeContent = contentState(target.content);
    const beforeContext = contextState(target.store);
    const beforeContextFile = await readFile(target.store.databaseFile);
    const failing: ContentDbPort = {
      ...target.content,
      persist: async () => {
        throw new Error("disco cheio");
      },
    };

    await expect(
      applyBackup(
        buildBackup({
          content: source.content,
          context: source.store,
          now: () => new Date(at),
          appVersion: "0.1.0",
        }),
        deps(failing, target.store),
      ),
    ).rejects.toThrow("disco cheio");
    expect(contentState(target.content)).toEqual(beforeContent);
    expect(contextState(target.store)).toEqual(beforeContext);
    expect(await readFile(target.store.databaseFile)).toEqual(
      beforeContextFile,
    );
  });

  it("restores the content database when replacing ideas fails (AT-008)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const target = await environment("target");
    const beforeContent = contentState(target.content);
    const beforeFile = await readFile(target.content.databaseFile());
    const failingStore: ContextStorePort = {
      ...target.store,
      databaseFile: target.store.databaseFile,
      dumpRaw: target.store.dumpRaw.bind(target.store),
      dumpMemory: target.store.dumpMemory.bind(target.store),
      dumpConfig: target.store.dumpConfig.bind(target.store),
      replaceDatabase: target.store.replaceDatabase.bind(target.store),
      mutate: async () => {
        throw new Error("falha no banco de ideias");
      },
    };

    await expect(
      applyBackup(
        buildBackup({
          content: source.content,
          context: source.store,
          now: () => new Date(at),
          appVersion: "0.1.0",
        }),
        deps(target.content, failingStore),
      ),
    ).rejects.toThrow("falha no banco de ideias");
    expect(contentState(target.content)).toEqual(beforeContent);
    expect(await readFile(target.content.databaseFile())).toEqual(beforeFile);
  });

  it("keeps local key markers and machine-only config, clears orphans and keeps local indexing (Decisions 3 and 4)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    source.content
      .db()
      .run(
        "DELETE FROM settings WHERE key IN ('openai_key', 'typesafe_jev_key')",
      );
    await source.store.mutate((tx) =>
      tx.setConfig("real_sources_enabled", "false"),
    );
    const target = await environment("target");
    target.content
      .db()
      .run("INSERT INTO settings VALUES (?, ?)", ["openai_key", "stored"]);
    await target.store.mutate((tx) => {
      tx.setConfig("real_sources_enabled", "true");
      tx.put("projects", { id: "prj_localproject" } as never, null, at);
      tx.put(
        "evidence",
        { id: "ev_local0000001" } as never,
        "prj_localproject",
        at,
      );
      tx.put(
        "context_packages",
        { id: "pkg_00000001" } as never,
        "op_oldlocal01",
        at,
      );
      tx.put("consents", { id: "con_00000001" } as never, "pkg_00000001", at);
    });

    await applyBackup(
      buildBackup({
        content: source.content,
        context: source.store,
        now: () => new Date(at),
        appVersion: "0.1.0",
      }),
      deps(target.content, target.store),
    );
    expect(
      target.content
        .dumpTable<{ key: string; value: string }>("settings")
        .find((row) => row.key === "openai_key")?.value,
    ).toBe("stored");
    expect(target.store.getConfig("real_sources_enabled")).toBe("true");
    expect(target.store.dumpRaw("projects").map((row) => row.id)).toEqual([
      "prj_localproject",
    ]);
    expect(target.store.dumpRaw("evidence").map((row) => row.id)).toEqual([
      "ev_local0000001",
    ]);
    expect(target.store.dumpRaw("context_packages")).toEqual([]);
    expect(target.store.dumpRaw("consents")).toEqual([]);
    expect(target.store.get("operations", "op_live0001")).toMatchObject({
      state: "interrupted",
      updatedAt: new Date("2026-09-24T10:11:12").toISOString(),
    });
    expect(target.store.get("operations", "op_done0001")).toMatchObject({
      state: "completed",
    });
  });

  it("exports without ideas when the feature is unavailable and refuses to import ideas without it (Decision 5)", async () => {
    const source = await environment("source");
    await seedSource(source.content, source.store);
    const contentOnly = buildBackup({
      content: source.content,
      context: null,
      now: () => new Date(at),
      appVersion: "0.1.0",
    });
    expect(contentOnly.projectContext).toBeNull();
    expect(summarize(contentOnly).projectContextIncluded).toBe(false);

    const target = await environment("target");
    const beforeFile = await readFile(target.content.databaseFile());
    const full = buildBackup({
      content: source.content,
      context: source.store,
      now: () => new Date(at),
      appVersion: "0.1.0",
    });
    await expect(applyBackup(full, deps(target.content, null))).rejects.toThrow(
      BackupFormatError,
    );
    expect(await readFile(target.content.databaseFile())).toEqual(beforeFile);
  });
});
