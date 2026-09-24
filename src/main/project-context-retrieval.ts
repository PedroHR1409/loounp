import { createHash } from "node:crypto";
import {
  limits,
  type Evidence,
  type Project,
  type SourceVersion,
} from "../core/project-ideas";
import type { ProjectContextStore } from "./project-context-store";

export type IndexedChunk = {
  id: string;
  sourceVersionId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  section: string | null;
  text: string;
};
export type GraphNode = {
  id: string;
  label: string;
  relativePath: string | null;
};
export type GraphEdge = { source: string; target: string; relation: string };
export type ProjectIndex = {
  projectId: string;
  generation: number;
  chunks: IndexedChunk[];
  graph: { status: string; nodes: GraphNode[]; edges: GraphEdge[] };
};
export type CatalogCoverage = {
  cataloged: number;
  consulted: number;
  excluded: number;
  pending: number;
  secretBlockedChunks: number;
  skippedDirectories: number;
  partial: boolean;
  graphStatus: Record<string, string>;
};

const shortHash = (value: string, size = 20) =>
  createHash("sha256").update(value).digest("hex").slice(0, size);
export const projectIdFor = (key: string) =>
  `prj_${shortHash(`project:${key}`, 16)}`;

const STOPWORDS = new Set(
  (
    "a o os as um uma de da do das dos e em no na nos nas por para com sem que se ao aos à às é ser são foi como mais mas ou seu sua seus suas este esta isso isto esse essa ele ela eles elas nao não sim já muito pouco quando onde qual quais sobre entre também pelo pela pelos pelas até " +
    "the a an of and or to in on for with without is are was were be been this that these those it its as at by from into over under your you we our they their not no yes can will just than then there here what when where which who how why about more most such only also very use using used"
  ).split(/\s+/),
);

const VOCABULARY: Record<string, string[]> = {
  busca: ["search"],
  pesquisa: ["search"],
  grafo: ["graph"],
  grafos: ["graph"],
  dados: ["data"],
  agente: ["agent"],
  agentes: ["agent"],
  recuperacao: ["retrieval"],
  embeddings: ["embedding", "vector"],
  vetorial: ["vector"],
  teste: ["test"],
  testes: ["test"],
  implantacao: ["deploy"],
  orquestracao: ["orchestration"],
  fila: ["queue"],
  cache: ["cache"],
  memoria: ["memory"],
  avaliacao: ["evaluation"],
  ranking: ["rank"],
  search: ["busca"],
  graph: ["grafo"],
  data: ["dados"],
  agent: ["agente"],
  retrieval: ["recuperacao"],
  memory: ["memoria"],
  evaluation: ["avaliacao"],
};

export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(
      (token) =>
        token.length > 1 && !STOPWORDS.has(token) && !/^\d+$/.test(token),
    );
}

export function queryTerms(title: string, text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const token of tokenize(text))
    counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40))
    weights.set(token, 1);
  for (const token of tokenize(title)) weights.set(token, 2);
  for (const [token, weight] of [...weights])
    for (const synonym of VOCABULARY[token] ?? [])
      if (!weights.has(synonym)) weights.set(synonym, weight * 0.6);
  return weights;
}

export function bm25(
  chunks: Array<{
    id: string;
    text: string;
    section?: string | null;
    relativePath?: string;
  }>,
  terms: Map<string, number>,
  k1 = 1.2,
  b = 0.75,
): Map<string, number> {
  const docs = chunks.map((chunk) => ({
    id: chunk.id,
    tokens: tokenize(
      `${chunk.relativePath ?? ""} ${chunk.section ?? ""} ${chunk.text}`,
    ),
  }));
  const average =
    docs.reduce((sum, doc) => sum + doc.tokens.length, 0) /
    Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const doc of docs)
    for (const token of new Set(doc.tokens))
      if (terms.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
  const scores = new Map<string, number>();
  for (const doc of docs) {
    const tf = new Map<string, number>();
    for (const token of doc.tokens)
      if (terms.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const [token, frequency] of tf) {
      const idf = Math.log(
        1 + (docs.length - df.get(token)! + 0.5) / (df.get(token)! + 0.5),
      );
      score +=
        (terms.get(token)! * idf * (frequency * (k1 + 1))) /
        (frequency +
          k1 * (1 - b + (b * doc.tokens.length) / Math.max(1, average)));
    }
    if (score > 0) scores.set(doc.id, score);
  }
  return scores;
}

type WorkerFile = {
  relativePath: string;
  identity: string;
  bytes: number;
  sha256: string;
  modifiedAt: number;
  status: SourceVersion["status"];
};
type WorkerChunk = {
  relativePath: string;
  sha256: string;
  startLine: number;
  endLine: number;
  section: string | null;
  text: string;
};
type WorkerProject = {
  project: {
    key: string;
    label: string;
    relativeRoot: string;
    markers: string[];
  };
  files: WorkerFile[];
  chunks: WorkerChunk[];
  excluded: unknown[];
  graph: { status: string; nodes?: GraphNode[]; edges?: GraphEdge[] };
};

function assertWorkerProject(value: unknown): WorkerProject {
  const record = value as WorkerProject;
  if (
    !record ||
    typeof record !== "object" ||
    !record.project ||
    typeof record.project.key !== "string" ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.chunks)
  )
    throw new Error("Resposta do worker com formato de projeto inválido.");
  for (const chunk of record.chunks)
    if (
      typeof chunk.relativePath !== "string" ||
      typeof chunk.text !== "string" ||
      !Number.isInteger(chunk.startLine) ||
      /^([a-z]:|[\\/])/i.test(chunk.relativePath) ||
      chunk.relativePath.split("/").includes("..")
    )
      throw new Error("Trecho com caminho inválido recusado.");
  return record;
}

export async function ingestCatalog(
  store: ProjectContextStore,
  response: Record<string, unknown>,
  projectFiles: Record<string, unknown>,
  now: Date,
): Promise<CatalogCoverage> {
  const summaries = Array.isArray(response.projects)
    ? (response.projects as Array<{
        file: string;
        pending?: number;
        secretBlockedChunks?: number;
        truncated?: boolean;
      }>)
    : [];
  const coverage: CatalogCoverage = {
    cataloged: 0,
    consulted: 0,
    excluded: 0,
    pending: 0,
    secretBlockedChunks: 0,
    skippedDirectories: Number(response.skippedDirectories ?? 0),
    partial: response.state !== "completed",
    graphStatus: {},
  };
  const at = now.toISOString();
  const indexes: ProjectIndex[] = [];
  await store.mutate((tx) => {
    for (const summary of summaries) {
      const data = assertWorkerProject(projectFiles[summary.file]);
      const projectId = projectIdFor(data.project.key);
      const previous = store.get("projects", projectId);
      const generation = (previous?.indexGeneration ?? 0) + 1;
      const versions = new Map<string, SourceVersion>();
      for (const file of data.files) {
        const version: SourceVersion = {
          id: `src_${shortHash(`${projectId}|${file.relativePath}|${file.sha256}`)}`,
          projectId,
          relativePath: file.relativePath,
          fileIdentity: String(file.identity),
          bytes: Number(file.bytes),
          sha256: String(file.sha256),
          modifiedAt: new Date(Number(file.modifiedAt) * 1000).toISOString(),
          eligible: file.status === "indexed",
          status: file.status,
          indexGeneration: generation,
        };
        if (!store.get("source_versions", version.id))
          tx.put("source_versions", version, projectId, at);
        versions.set(`${file.relativePath}|${file.sha256}`, version);
      }
      const chunks = data.chunks.flatMap((chunk): IndexedChunk[] => {
        const version = versions.get(`${chunk.relativePath}|${chunk.sha256}`);
        return version
          ? [
              {
                id: `chk_${shortHash(`${version.id}|${chunk.startLine}|${chunk.endLine}`)}`,
                sourceVersionId: version.id,
                relativePath: chunk.relativePath,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                section: chunk.section,
                text: chunk.text,
              },
            ]
          : [];
      });
      const project: Project = {
        id: projectId,
        label: data.project.label.slice(0, 120),
        relativeRoot: data.project.relativeRoot,
        markers: data.project.markers.slice(0, 20),
        status: summary.pending || summary.truncated ? "pending" : "consulted",
        indexGeneration: generation,
        updatedAt: at,
      };
      tx.put("projects", project, null, previous ? previous.updatedAt : at);
      indexes.push({
        projectId,
        generation,
        chunks,
        graph: {
          status: data.graph?.status ?? "unknown",
          nodes: data.graph?.nodes ?? [],
          edges: data.graph?.edges ?? [],
        },
      });
      coverage.cataloged += 1;
      coverage.consulted += data.files.filter(
        (file) => file.status === "indexed",
      ).length;
      coverage.excluded +=
        data.excluded.length +
        data.files.filter((file) => file.status !== "indexed").length;
      coverage.pending += Number(summary.pending ?? 0);
      coverage.secretBlockedChunks += Number(summary.secretBlockedChunks ?? 0);
      coverage.graphStatus[project.label] = data.graph?.status ?? "unknown";
    }
    tx.setConfig("last_catalog", JSON.stringify({ at, coverage }));
  });
  for (const index of indexes) await store.writeIndex(index.projectId, index);
  return coverage;
}

export type RetrievalResult = {
  evidence: Evidence[];
  candidates: number;
  projectsSearched: string[];
  candidateFiles: string[];
  neighborFiles: string[];
};

export async function retrieveEvidence(
  store: ProjectContextStore,
  article: { title: string; text: string },
  projectIds?: string[],
  options: { graph?: boolean; ignoredPaths?: Set<string> } = {},
): Promise<RetrievalResult> {
  const projects = store
    .list("projects")
    .filter((project) => !projectIds || projectIds.includes(project.id));
  const indexes = (
    await Promise.all(
      projects.map((project) => store.readIndex<ProjectIndex>(project.id)),
    )
  ).filter((index): index is ProjectIndex => Boolean(index));
  const chunkById = new Map<string, IndexedChunk & { projectId: string }>();
  for (const index of indexes)
    for (const chunk of index.chunks)
      if (!options.ignoredPaths?.has(chunk.relativePath))
        chunkById.set(chunk.id, { ...chunk, projectId: index.projectId });
  const scores = bm25(
    [...chunkById.values()],
    queryTerms(article.title, article.text),
  );
  const candidates = [...scores]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limits.retrieval.candidates)
    .map(([id]) => chunkById.get(id)!);
  const neighbors: Array<{
    chunk: IndexedChunk & { projectId: string };
    relation: string;
  }> = [];
  const seen = new Set(candidates.map((chunk) => chunk.id));
  for (const candidate of options.graph === false ? [] : candidates) {
    if (neighbors.length >= limits.retrieval.graphNeighbors) break;
    const index = indexes.find(
      (item) => item.projectId === candidate.projectId,
    )!;
    const nodes = new Map(index.graph.nodes.map((node) => [node.id, node]));
    const local = new Set(
      index.graph.nodes
        .filter((node) => node.relativePath === candidate.relativePath)
        .map((node) => node.id),
    );
    for (const edge of index.graph.edges) {
      if (neighbors.length >= limits.retrieval.graphNeighbors) break;
      const otherId = local.has(edge.source)
        ? edge.target
        : local.has(edge.target)
          ? edge.source
          : null;
      const other = otherId ? nodes.get(otherId) : undefined;
      if (
        !other?.relativePath ||
        other.relativePath === candidate.relativePath ||
        options.ignoredPaths?.has(other.relativePath)
      )
        continue;
      const name = other.label.replace(/\(.*$/, "").trim();
      const target =
        index.chunks.find(
          (chunk) =>
            chunk.relativePath === other.relativePath &&
            name &&
            chunk.text.includes(name),
        ) ??
        index.chunks.find((chunk) => chunk.relativePath === other.relativePath);
      if (!target || seen.has(target.id)) continue;
      seen.add(target.id);
      neighbors.push({
        chunk: { ...target, projectId: index.projectId },
        relation: `${edge.relation}: ${candidate.relativePath} → ${other.relativePath}`,
      });
    }
  }
  const selected: Evidence[] = [];
  const perProject = new Map<string, number>();
  const files = new Set<string>();
  let chars = 0;
  const pool = [
    ...candidates.map((chunk) => ({ chunk, relation: null as string | null })),
    ...neighbors,
  ];
  for (const { chunk, relation } of pool) {
    if (selected.length >= limits.retrieval.maxEvidence) break;
    const count = perProject.get(chunk.projectId) ?? 0;
    const fileKey = `${chunk.sourceVersionId}|${chunk.startLine}`;
    if (
      count >= limits.retrieval.maxPerProject ||
      files.has(fileKey) ||
      chars + chunk.text.length > limits.retrieval.maxEvidenceChars
    )
      continue;
    files.add(fileKey);
    perProject.set(chunk.projectId, count + 1);
    chars += chunk.text.length;
    selected.push({
      id: `evd_${shortHash(chunk.id)}`,
      sourceVersionId: chunk.sourceVersionId,
      projectId: chunk.projectId,
      relativePath: chunk.relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      section: chunk.section,
      excerpt: chunk.text,
      origin: relation ? "inferred" : "extracted",
      graphRelations: relation ? [relation] : [],
    });
  }
  return {
    evidence: selected,
    candidates: candidates.length,
    projectsSearched: indexes.map((index) => index.projectId),
    candidateFiles: candidates.map((chunk) => chunk.relativePath),
    neighborFiles: neighbors.map((item) => item.chunk.relativePath),
  };
}
