import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bm25,
  ingestCatalog,
  projectIdFor,
  queryTerms,
  retrieveEvidence,
  tokenize,
} from "./project-context-retrieval";
import { ProjectContextStore } from "./project-context-store";

let base: string;
let store: ProjectContextStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "a2p-retrieval-"));
  await mkdir(join(base, "Projetos"));
  store = await ProjectContextStore.open({
    baseDirectory: join(base, "userData"),
    protectedRoot: join(base, "Projetos"),
  });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const file = (relativePath: string, sha256: string) => ({
  relativePath,
  identity: "1:2",
  bytes: 10,
  sha256,
  modifiedAt: 1790000000,
  status: "indexed",
});
const chunk = (
  relativePath: string,
  sha256: string,
  text: string,
  startLine = 1,
) => ({
  relativePath,
  sha256,
  startLine,
  endLine: startLine + 5,
  section: null,
  text,
});

function catalog() {
  const radar = {
    project: {
      key: "radar",
      label: "radar",
      relativeRoot: "radar",
      markers: ["README.md"],
    },
    files: [
      file("radar/README.md", "a".repeat(64)),
      file("radar/src/rank.ts", "b".repeat(64)),
      file("radar/src/store.ts", "c".repeat(64)),
    ],
    chunks: [
      chunk(
        "radar/README.md",
        "a".repeat(64),
        "O Radar ordena artigos com ranking explicável. Não há busca semântica nem embeddings.",
      ),
      chunk(
        "radar/src/rank.ts",
        "b".repeat(64),
        "export function rank(items) { return scoreItems(items) }",
      ),
      chunk(
        "radar/src/store.ts",
        "c".repeat(64),
        "export function scoreItems(items) { return items.map(weight) }",
      ),
    ],
    excluded: [
      { relativePath: "radar/.env", reason: "excluded_or_unsupported" },
    ],
    graph: {
      status: "ok",
      nodes: [
        { id: "gn_1", label: "rank()", relativePath: "radar/src/rank.ts" },
        {
          id: "gn_2",
          label: "scoreItems()",
          relativePath: "radar/src/store.ts",
        },
      ],
      edges: [{ source: "gn_1", target: "gn_2", relation: "calls" }],
    },
  };
  const docs = Array.from({ length: 8 }, (_, index) =>
    chunk(
      `notes/doc${index}.md`,
      String(index).repeat(64),
      `Busca semântica com embeddings e ranking híbrido, parte ${index}.`,
    ),
  );
  const notes = {
    project: {
      key: "notes",
      label: "notes",
      relativeRoot: "notes",
      markers: ["README.md"],
    },
    files: docs.map((doc) => file(doc.relativePath, doc.sha256)),
    chunks: docs,
    excluded: [],
    graph: { status: "no_code" },
  };
  return {
    response: {
      state: "partial",
      skippedDirectories: 1,
      projects: [
        { key: "radar", file: "project-0.json", pending: 0 },
        { key: "notes", file: "project-1.json", pending: 2 },
      ],
    },
    files: { "project-0.json": radar, "project-1.json": notes },
  };
}

describe("lexical retrieval", () => {
  it("tokenizes Portuguese and English without accents or stopwords", () => {
    expect(tokenize("Recuperação de dados com a Busca")).toEqual([
      "recuperacao",
      "dados",
      "busca",
    ]);
    expect(queryTerms("Busca em grafos", "").get("search")).toBeCloseTo(1.2);
  });

  it("scores matching chunks with BM25", () => {
    const scores = bm25(
      [
        { id: "x", text: "embeddings e busca" },
        { id: "y", text: "receita de bolo" },
      ],
      queryTerms("busca com embeddings", ""),
    );
    expect([...scores.keys()]).toEqual(["x"]);
  });
});

describe("catalog ingestion and evidence selection", () => {
  it("ingests versioned sources and reports coverage including pending work", async () => {
    const { response, files } = catalog();
    const coverage = await ingestCatalog(
      store,
      response,
      files,
      new Date("2026-09-23T12:00:00Z"),
    );
    expect(coverage).toMatchObject({
      cataloged: 2,
      consulted: 11,
      excluded: 1,
      pending: 2,
      partial: true,
      skippedDirectories: 1,
    });
    expect(store.get("projects", projectIdFor("notes"))?.status).toBe(
      "pending",
    );
    expect(store.list("source_versions")).toHaveLength(11);
  });

  it("limits evidence per project, expands one graph hop and marks the neighbor as inferred", async () => {
    const { response, files } = catalog();
    await ingestCatalog(
      store,
      response,
      files,
      new Date("2026-09-23T12:00:00Z"),
    );
    const result = await retrieveEvidence(store, {
      title: "Ranking híbrido com busca semântica e embeddings",
      text: "Como a função rank pode combinar embeddings.",
    });
    const byProject = result.evidence.reduce<Record<string, number>>(
      (acc, item) => ({
        ...acc,
        [item.projectId]: (acc[item.projectId] ?? 0) + 1,
      }),
      {},
    );
    expect(Math.max(...Object.values(byProject))).toBeLessThanOrEqual(4);
    const inferred = result.evidence.find((item) => item.origin === "inferred");
    expect(inferred?.relativePath).toBe("radar/src/store.ts");
    expect(inferred?.graphRelations[0]).toContain("calls");
  });

  it("skips graph expansion when disabled", async () => {
    const { response, files } = catalog();
    await ingestCatalog(
      store,
      response,
      files,
      new Date("2026-09-23T12:00:00Z"),
    );
    const result = await retrieveEvidence(
      store,
      {
        title: "Ranking híbrido com busca semântica e embeddings",
        text: "Como a função rank pode combinar embeddings.",
      },
      undefined,
      { graph: false },
    );
    expect(result.evidence.some((item) => item.origin === "inferred")).toBe(
      false,
    );
  });

  it("never selects ignored paths and lets other sources take the slot", async () => {
    const { response, files } = catalog();
    await ingestCatalog(
      store,
      response,
      files,
      new Date("2026-09-23T12:00:00Z"),
    );
    const article = {
      title: "Ranking híbrido com busca semântica e embeddings",
      text: "Como a função rank pode combinar embeddings.",
    };
    const before = await retrieveEvidence(store, article);
    expect(
      before.evidence.some((item) => item.relativePath === "radar/README.md"),
    ).toBe(true);
    const after = await retrieveEvidence(store, article, undefined, {
      ignoredPaths: new Set(["radar/README.md", "radar/src/store.ts"]),
    });
    expect(
      after.evidence.some(
        (item) =>
          item.relativePath === "radar/README.md" ||
          item.relativePath === "radar/src/store.ts",
      ),
    ).toBe(false);
    expect(after.evidence.length).toBeGreaterThan(0);
  });

  it("rejects worker chunks that point outside the project", async () => {
    const { response, files } = catalog();
    (
      files["project-0.json"].chunks[0] as { relativePath: string }
    ).relativePath = "C:/Windows/win.ini";
    await expect(
      ingestCatalog(store, response, files, new Date()),
    ).rejects.toThrow("caminho inválido");
  });

  it("manual project selection restricts the search", async () => {
    const { response, files } = catalog();
    await ingestCatalog(
      store,
      response,
      files,
      new Date("2026-09-23T12:00:00Z"),
    );
    const result = await retrieveEvidence(
      store,
      { title: "embeddings", text: "" },
      [projectIdFor("radar")],
    );
    expect(
      result.evidence.every((item) => item.projectId === projectIdFor("radar")),
    ).toBe(true);
  });
});
