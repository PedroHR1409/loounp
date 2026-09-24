import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  symlink,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSafeExternalPath,
  ProjectContextStore,
  SchemaVersionError,
  StoreLocationError,
} from "./project-context-store";
import { confirm, propose, emptyLedger } from "../core/personal-memory";
import type { Operation, Recommendation } from "../core/project-ideas";

let base: string;
let protectedRoot: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "a2p-store-"));
  protectedRoot = join(base, "Projetos");
  await mkdir(protectedRoot);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const operation = (
  id: string,
  createdAt = "2026-09-23T12:00:00.000Z",
): Operation => ({
  id,
  state: "completed",
  article: null,
  contentId: null,
  purpose: "both",
  selectedProjectIds: null,
  projectsConsulted: false,
  attempt: 1,
  currentPackageId: null,
  contextMode: "full",
  comparisonOf: null,
  error: null,
  createdAt,
  updatedAt: createdAt,
});

describe("project context store", () => {
  it("refuses to live inside the protected projects root or behind a redirect", async () => {
    await expect(
      ProjectContextStore.open({
        baseDirectory: join(protectedRoot, "app-data"),
        protectedRoot,
      }),
    ).rejects.toThrow(StoreLocationError);
    const target = join(base, "real");
    await mkdir(target);
    const link = join(base, "link");
    await symlink(target, link, "junction");
    await expect(
      assertSafeExternalPath(join(link, "inner"), protectedRoot),
    ).rejects.toThrow("redirecionamento");
    await expect(
      assertSafeExternalPath(
        join(protectedRoot, "..", "Projetos", "x"),
        protectedRoot,
      ),
    ).rejects.toThrow(StoreLocationError);
  });

  it("persists memory revisions atomically and reloads them", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    const ledger = confirm(
      propose(
        emptyLedger(),
        {
          memoryId: "mem_00000001",
          kind: "goal",
          text: "Aprender RAG na prática",
          origin: "user_declared",
        },
        "2026-09-23T12:00:00.000Z",
      ),
      "mem_00000001",
      1,
      1,
      "2026-09-23T12:01:00.000Z",
    );
    await store.mutate((tx) => tx.writeLedger(ledger));
    const reopened = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    expect(reopened.ledger().revisions[0]).toMatchObject({
      state: "confirmed",
      text: "Aprender RAG na prática",
    });
    expect(reopened.ledger().globalRevision).toBe(1);
  });

  it("rolls back a failed mutation without partial writes", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    await expect(
      store.mutate((tx) => {
        tx.put(
          "operations",
          operation("op_00000001"),
          null,
          "2026-09-23T12:00:00.000Z",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.get("operations", "op_00000001")).toBeNull();
    await store.mutate((tx) =>
      tx.put(
        "operations",
        operation("op_00000002"),
        null,
        "2026-09-23T12:00:00.000Z",
      ),
    );
    expect(store.get("operations", "op_00000002")?.state).toBe("completed");
  });

  it("does not overwrite a database created by a newer schema", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    await store.mutate((tx) => tx.setConfig("schema_version", "99"));
    const before = await readFile(
      join(store.directory, "project-context.sqlite"),
    );
    await expect(
      ProjectContextStore.open({
        baseDirectory: join(base, "userData"),
        protectedRoot,
      }),
    ).rejects.toThrow(SchemaVersionError);
    expect(
      await readFile(join(store.directory, "project-context.sqlite")),
    ).toEqual(before);
  });

  it("applies retention to old results and stale indexes", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    const old = "2026-01-01T00:00:00.000Z";
    const recommendation = {
      id: "rec_00000001",
      operationId: "op_00000001",
      createdAt: old,
    } as Recommendation;
    await store.mutate((tx) => {
      tx.put("operations", operation("op_00000001", old), null, old);
      tx.put("recommendations", recommendation, "op_00000001", old);
    });
    await store.writeIndex("prj_00000001", { chunks: [] });
    const indexFile = store.indexPath("prj_00000001");
    await utimes(indexFile, new Date(old), new Date(old));
    const result = await store.applyRetention(
      new Date("2026-09-23T00:00:00.000Z"),
    );
    expect(result).toEqual({ removedResults: 1, removedIndexes: 1 });
    expect(store.get("operations", "op_00000001")).toBeNull();
    await expect(readFile(indexFile)).rejects.toThrow();
  });

  it("keeps graph expansion off by default after Gate 2 did not pass", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    expect(store.graphExpansionEnabled()).toBe(false);
    await store.mutate((tx) => tx.setConfig("graph_expansion", "true"));
    expect(store.graphExpansionEnabled()).toBe(true);
  });

  it("stores ignored sources and the last purpose", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    expect(store.lastPurpose()).toBe("both");
    await store.mutate((tx) => {
      tx.put(
        "ignored_sources",
        {
          id: "ign_00000001",
          kind: "file",
          relativePath: "loounp/scripts/gate3/sample.json",
          memoryId: null,
          label: "sample.json",
          createdAt: "2026-09-23T12:00:00.000Z",
        },
        null,
        "2026-09-23T12:00:00.000Z",
      );
      tx.put(
        "ignored_sources",
        {
          id: "ign_00000002",
          kind: "memory",
          relativePath: null,
          memoryId: "mem_00000001",
          label: "objetivo",
          createdAt: "2026-09-23T12:00:00.000Z",
        },
        null,
        "2026-09-23T12:00:00.000Z",
      );
      tx.setConfig("last_purpose", "portfolio");
    });
    expect([...store.ignoredPaths()]).toEqual([
      "loounp/scripts/gate3/sample.json",
    ]);
    expect([...store.ignoredMemories()]).toEqual(["mem_00000001"]);
    expect(store.lastPurpose()).toBe("portfolio");
  });

  it("rejects index paths derived from untrusted identifiers", async () => {
    const store = await ProjectContextStore.open({
      baseDirectory: join(base, "userData"),
      protectedRoot,
    });
    expect(() => store.indexPath("..\\..\\evil")).toThrow("inválido");
  });
});
