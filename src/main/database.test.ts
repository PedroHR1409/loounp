import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  all,
  databaseFile,
  dumpTable,
  exportBytes,
  getSetting,
  openDatabase,
  persist,
  restoreBytes,
  run,
  setSetting,
  transaction,
} from "./database";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "loounp-database-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("cria banco novo quando o arquivo não existe (AT-001)", async () => {
    await openDatabase(tempDir);
    expect(databaseFile()).toBe(join(tempDir, "content-discovery.sqlite"));
    expect(dumpTable("settings")).toEqual([]);
  });

  it("reabre um banco já persistido sem perder dados (AT-002)", async () => {
    await openDatabase(tempDir);
    setSetting("k", "v1");
    await persist();
    await openDatabase(tempDir);
    expect(getSetting("k")).toBe("v1");
  });

  it("relança erro não-ENOENT ao abrir (AT-003)", async () => {
    await mkdir(join(tempDir, "content-discovery.sqlite"));
    await expect(openDatabase(tempDir)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});

describe("getSetting/setSetting", () => {
  it("faz upsert: segunda chamada atualiza, não duplica (AT-004)", async () => {
    await openDatabase(tempDir);
    setSetting("k", "v1");
    setSetting("k", "v2");
    expect(getSetting("k")).toBe("v2");
    expect(
      dumpTable<{ key: string }>("settings").filter((row) => row.key === "k"),
    ).toHaveLength(1);
  });
});

describe("all/run", () => {
  it("bind de parâmetros funciona em ambas as direções (AT-005)", async () => {
    await openDatabase(tempDir);
    run("INSERT INTO content(id, url, source, data) VALUES (?, ?, ?, ?)", [
      "c1",
      "https://x",
      "devto",
      "{}",
    ]);
    expect(
      all<{ id: string }>("SELECT id FROM content WHERE source = ?", ["devto"]),
    ).toEqual([{ id: "c1" }]);
  });
});

describe("dumpTable", () => {
  it("retorna todas as linhas de uma tabela", async () => {
    await openDatabase(tempDir);
    run(
      "INSERT INTO medium_archive_signals(content_id, signal) VALUES (?, ?)",
      ["m1", "clap"],
    );
    expect(dumpTable("medium_archive_signals")).toEqual([
      { content_id: "m1", signal: "clap" },
    ]);
  });
});

describe("transaction", () => {
  it("commita todas as escritas no caminho de sucesso (AT-006)", async () => {
    await openDatabase(tempDir);
    transaction((execute) => {
      execute("INSERT INTO settings(key, value) VALUES (?, ?)", ["a", "1"]);
      execute("INSERT INTO settings(key, value) VALUES (?, ?)", ["b", "2"]);
    });
    expect(getSetting("a")).toBe("1");
    expect(getSetting("b")).toBe("2");
  });

  it("reverte todas as escritas se a função lançar (AT-007)", async () => {
    await openDatabase(tempDir);
    expect(() =>
      transaction((execute) => {
        execute("INSERT INTO settings(key, value) VALUES (?, ?)", ["a", "1"]);
        throw new Error("falha proposital");
      }),
    ).toThrow("falha proposital");
    expect(getSetting("a")).toBeNull();
  });
});

describe("exportBytes/restoreBytes", () => {
  it("faz round-trip de bytes entre instâncias (AT-008)", async () => {
    await openDatabase(tempDir);
    setSetting("k", "v1");
    const bytes = exportBytes();
    restoreBytes(bytes);
    expect(getSetting("k")).toBe("v1");
  });
});

describe("databaseFile", () => {
  it("retorna o caminho usado por openDatabase (AT-009)", async () => {
    await openDatabase(tempDir);
    expect(databaseFile()).toBe(join(tempDir, "content-discovery.sqlite"));
  });
});
