import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bm25,
  cosine,
  hybridOrder,
  ingestCatalog,
  projectIdFor,
  queryTerms,
  retrieveEvidence,
  tokenize,
} from "./retrieval";
import { ProjectContextStore } from "./store";

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
    expect(tokenize("text embeddings")).toEqual(["embeddings"]);
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

  it("ignores the generic text token when scoring a long article", () => {
    const article = {
      title: "Caching embeddings avoids paying twice for the same text",
      text: "In retrieval augmented generation pipelines, questions and documents are embedded repeatedly; a content-addressed cache keyed by the hash of the text and the model name cuts latency and cost. We cover invalidation when the embedding model changes.",
    };
    const scores = bm25(
      [
        {
          id: "encoder",
          text: 'ENCODER_ID = "text-small"\n\ndef encode_batch(texts):\n    return [_encode(text) for text in texts]',
          relativePath: "notes-rag/src/encoder.py",
        },
      ],
      queryTerms(article.title, article.text),
    );
    expect(scores.has("encoder")).toBe(false);
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
      text: "The rank function can combine embeddings.",
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

  it("does not expand graph neighbors from a one-word incidental match", async () => {
    const { response, files } = catalog();
    files["project-0.json"].chunks[1].text += " change";
    await ingestCatalog(store, response, files, new Date());

    const result = await retrieveEvidence(store, { title: "Change", text: "" });

    expect(result.evidence.some((item) => item.origin === "inferred")).toBe(
      false,
    );
  });

  it("promotes a connected lexical candidate excluded by the project cap", async () => {
    const docs = [
      chunk(
        "capacity/src/seed.ts",
        "a".repeat(64),
        "function seed() { ingestion contract partner schema csv }",
      ),
      ...["b", "c", "d"].map((hash, index) =>
        chunk(
          `capacity/src/high-${index}.ts`,
          hash.repeat(64),
          `function high${index}() { ingestion contract partner schema csv }`,
        ),
      ),
      chunk(
        "capacity/src/target.ts",
        "e".repeat(64),
        "function target() { partner csv }",
      ),
    ];
    const response = {
      state: "completed",
      projects: [{ file: "project-0.json", pending: 0 }],
    };
    const files = {
      "project-0.json": {
        project: {
          key: "capacity",
          label: "capacity",
          relativeRoot: "capacity",
          markers: ["README.md"],
        },
        files: docs.map((doc) => file(doc.relativePath, doc.sha256)),
        chunks: docs,
        excluded: [],
        graph: {
          status: "ok",
          nodes: [
            {
              id: "seed",
              label: "seed()",
              relativePath: "capacity/src/seed.ts",
            },
            {
              id: "target",
              label: "target()",
              relativePath: "capacity/src/target.ts",
            },
          ],
          edges: [{ source: "seed", target: "target", relation: "calls" }],
        },
      },
    };
    await ingestCatalog(store, response, files, new Date());
    const article = {
      title: "Data contracts for partner CSV ingestion",
      text: "Validate partner schemas during ingestion.",
    };

    const lexical = await retrieveEvidence(store, article, undefined, {
      graph: false,
    });
    const hybrid = await retrieveEvidence(store, article);

    expect(
      lexical.evidence.some(
        (item) => item.relativePath === "capacity/src/target.ts",
      ),
    ).toBe(false);
    expect(
      hybrid.evidence.find(
        (item) => item.relativePath === "capacity/src/target.ts",
      ),
    ).toMatchObject({ origin: "inferred" });
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
        text: "The rank function can combine embeddings.",
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
      text: "The rank function can combine embeddings.",
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

describe("semantic reranking", () => {
  const article = {
    title: "Ranking híbrido com busca semântica e embeddings",
    text: "The rank function can combine embeddings.",
  };

  function singleProject() {
    const docs = [
      ...Array.from({ length: 5 }, (_, index) =>
        chunk(
          `semantic/doc${index}.md`,
          String(index).repeat(64),
          `Ranking híbrido com busca semântica e embeddings. ${"texto extra ".repeat(index)}`,
        ),
      ),
      chunk(
        "semantic/alvo.md",
        "f".repeat(64),
        "Reordenar resultados combinando notas: embeddings aparecem aqui só uma vez, no meio de um texto longo sobre pesos, normalização, listas, empates e como explicar a ordem final para quem usa o aplicativo no dia a dia.",
      ),
    ];
    return {
      response: {
        state: "completed",
        projects: [{ key: "semantic", file: "project-0.json", pending: 0 }],
      },
      files: {
        "project-0.json": {
          project: {
            key: "semantic",
            label: "semantic",
            relativeRoot: "semantic",
            markers: ["README.md"],
          },
          files: docs.map((doc) => file(doc.relativePath, doc.sha256)),
          chunks: docs,
          excluded: [],
          graph: { status: "no_code" },
        },
      },
    };
  }

  async function ingest(data: {
    response: Record<string, unknown>;
    files: Record<string, unknown>;
  }) {
    await ingestCatalog(
      store,
      data.response,
      data.files,
      new Date("2026-09-23T12:00:00Z"),
    );
  }

  const pointing = (target: string) => async (texts: string[]) =>
    texts.map((text, index) =>
      index === 0 || text.startsWith(target) ? [1, 0] : [-1, 0],
    );

  it("cosine is 1 for the same direction, 0 for orthogonal or empty vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("hybridOrder only reorders, keeps BM25 order on ties and on flat scales", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const scores = new Map([
      ["a", 3],
      ["b", 2],
      ["c", 1],
    ]);
    const lifted = hybridOrder(
      items,
      scores,
      [1, 0],
      [
        [-1, 0],
        [-1, 0],
        [1, 0],
      ],
    );
    expect(lifted.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(
      hybridOrder(
        items,
        scores,
        [1, 0],
        [
          [1, 0],
          [1, 0],
          [1, 0],
        ],
      ).map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
    expect(new Set(lifted)).toEqual(new Set(items));
  });

  it("lifts a meaningful chunk that BM25 left out of the per-project limit (AT-001)", async () => {
    await ingest(singleProject());
    const baseline = await retrieveEvidence(store, article);
    expect(baseline.candidateFiles.at(-1)).toBe("semantic/alvo.md");
    expect(
      baseline.evidence.some(
        (item) => item.relativePath === "semantic/alvo.md",
      ),
    ).toBe(false);
    const result = await retrieveEvidence(store, article, undefined, {
      embed: pointing("semantic/alvo.md"),
    });
    expect(result.semantic).toBe("applied");
    expect(
      result.evidence.some((item) => item.relativePath === "semantic/alvo.md"),
    ).toBe(true);
    expect(result.evidence).toHaveLength(baseline.evidence.length);
    expect(result.evidence.every((item) => item.origin === "extracted")).toBe(
      true,
    );
  });

  it("without embed the result is today's result with semantic off (AT-002)", async () => {
    const { response, files } = catalog();
    await ingest({ response, files });
    const result = await retrieveEvidence(store, article);
    expect(result.semantic).toBe("off");
    const flat = await retrieveEvidence(store, article, undefined, {
      embed: async (texts) => texts.map(() => [1, 1]),
    });
    expect({ ...flat, semantic: "off" }).toEqual(result);
  });

  it("does not call embed with zero or one candidate (AT-003)", async () => {
    const { response, files } = catalog();
    await ingest({ response, files });
    let calls = 0;
    const embed = async (texts: string[]) => {
      calls += 1;
      return texts.map(() => [1, 0]);
    };
    const none = await retrieveEvidence(
      store,
      { title: "receita de bolo", text: "farinha açúcar forno" },
      undefined,
      { embed },
    );
    expect(none.evidence).toEqual([]);
    expect(none.semantic).toBe("off");
    const one = await retrieveEvidence(
      store,
      { title: "explicável", text: "" },
      undefined,
      { embed },
    );
    expect(one.candidates).toBe(1);
    expect(one.semantic).toBe("off");
    expect(calls).toBe(0);
  });

  it("falls back to BM25 order when embed throws", async () => {
    await ingest(singleProject());
    const baseline = await retrieveEvidence(store, article);
    const result = await retrieveEvidence(store, article, undefined, {
      embed: async () => {
        throw new Error("rede fora");
      },
    });
    expect(result.semantic).toBe("failed");
    expect(result.evidence).toEqual(baseline.evidence);
  });

  it("falls back when the response has missing or non-finite vectors", async () => {
    await ingest(singleProject());
    const baseline = await retrieveEvidence(store, article);
    const short = await retrieveEvidence(store, article, undefined, {
      embed: async (texts) => texts.slice(1).map(() => [1, 0]),
    });
    expect(short.semantic).toBe("failed");
    expect(short.evidence).toEqual(baseline.evidence);
    const nan = await retrieveEvidence(store, article, undefined, {
      embed: async (texts) => texts.map(() => [Number.NaN, 0]),
    });
    expect(nan.semantic).toBe("failed");
    expect(nan.evidence).toEqual(baseline.evidence);
  });

  it("rethrows when the user canceled", async () => {
    await ingest(singleProject());
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieveEvidence(store, article, undefined, {
        embed: async () => {
          throw new Error("abortado");
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("abortado");
  });
});
