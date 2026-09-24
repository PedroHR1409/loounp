import { it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type {
  Evaluation,
  Operation,
  Recommendation,
  SourceVersion,
} from "../../src/core/project-ideas";
import type { AuditEntry } from "../../src/main/project-context-store";

const require = createRequire(import.meta.url);
type SampleItem = {
  key: string;
  kind: "applicable" | "no_application";
  contentId: string;
  title: string;
  url: string;
};

it("builds the Gate 3 report from the feature database (read-only)", async () => {
  const sample = JSON.parse(
    await readFile(join(__dirname, "sample.json"), "utf8"),
  ) as { preRegisteredAt: string; sample: SampleItem[] };
  const SQL = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  const databasePath = join(
    process.env.APPDATA!,
    "content-discovery-poc",
    "article-to-project",
    "project-context.sqlite",
  );
  const bytes = await readFile(databasePath).catch(() => null);
  if (!bytes) {
    console.log(
      "Gate 3: sem dados ainda; o banco da feature não existe (" +
        databasePath +
        "). Abra o app atualizado e execute as explorações.",
    );
    return;
  }
  const database = new SQL.Database(new Uint8Array(bytes));
  const rows = <T>(table: string) => {
    const statement = database.prepare(`SELECT data FROM ${table}`);
    const out: T[] = [];
    while (statement.step())
      out.push(JSON.parse(String(statement.getAsObject().data)) as T);
    statement.free();
    return out;
  };
  const operations = rows<Operation>("operations");
  const recommendations = rows<Recommendation>("recommendations");
  const evaluations = rows<Evaluation>("evaluations");
  const versions = new Set(
    rows<SourceVersion>("source_versions").map((version) => version.id),
  );
  const audit = rows<AuditEntry>("audit");
  database.close();

  const items = sample.sample.map((item) => {
    const contextual = operations
      .filter(
        (operation) =>
          operation.contentId === item.contentId &&
          operation.contextMode === "full" &&
          operation.state === "completed" &&
          Date.parse(operation.createdAt) >= Date.parse(sample.preRegisteredAt),
      )
      .map((operation) => ({
        operation,
        recommendation: recommendations.find(
          (candidate) => candidate.operationId === operation.id,
        ),
      }))
      .filter((entry) => entry.recommendation)
      .sort((a, b) =>
        a.operation.createdAt.localeCompare(b.operation.createdAt),
      )
      .at(-1);
    const recommendation = contextual?.recommendation ?? null;
    const evaluation = contextual
      ? (evaluations.find(
          (candidate) =>
            candidate.contextOperationId === contextual.operation.id,
        ) ?? null)
      : null;
    const cited = recommendation?.citedEvidence ?? [];
    const unresolved = cited.filter(
      (entry) => entry.sourceVersionId && !versions.has(entry.sourceVersionId),
    ).length;
    return {
      key: item.key,
      kind: item.kind,
      title: item.title,
      ran: Boolean(recommendation),
      status: recommendation?.status ?? null,
      modality: recommendation?.modality ?? null,
      projectsConsulted: contextual?.operation.projectsConsulted ?? null,
      rating: recommendation?.rating?.score ?? null,
      comment: recommendation?.rating?.comment ?? null,
      preference: evaluation?.preference ?? null,
      order: evaluation?.order ?? null,
      citations: cited.length,
      projectCitations: cited.filter((entry) => entry.sourceVersionId).length,
      unresolvedCitations: unresolved,
      calls: contextual
        ? audit.filter(
            (entry) =>
              entry.operationId === contextual.operation.id &&
              entry.event === "call_sent",
          ).length
        : 0,
      seconds: contextual
        ? Math.round(
            (Date.parse(contextual.operation.updatedAt) -
              Date.parse(contextual.operation.createdAt)) /
              1000,
          )
        : null,
    };
  });
  const applicable = items.filter((item) => item.kind === "applicable");
  const none = items.filter((item) => item.kind === "no_application");
  const targets = {
    applicableUseful: {
      observed: applicable.filter((item) => (item.rating ?? 0) >= 4).length,
      required: 6,
      of: 8,
      rated: applicable.filter((item) => item.rating !== null).length,
    },
    contextPreference: {
      observed: applicable.filter((item) => item.preference === "context")
        .length,
      required: 5,
      of: 8,
      decided: applicable.filter((item) => item.preference !== null).length,
      plain: applicable.filter((item) => item.preference === "plain").length,
      ties: applicable.filter((item) => item.preference === "tie").length,
    },
    noApplication: {
      withoutRecommendation: none.filter(
        (item) =>
          item.status === "no_application" ||
          item.status === "insufficient_context",
      ).length,
      of: 2,
      ran: none.filter((item) => item.ran).length,
    },
    citations: {
      total: items.reduce((sum, item) => sum + item.citations, 0),
      unresolved: items.reduce(
        (sum, item) => sum + item.unresolvedCitations,
        0,
      ),
    },
  };
  const complete =
    items.every((item) => item.ran) &&
    targets.applicableUseful.rated === 8 &&
    targets.contextPreference.decided === 8;
  const verdict = !complete
    ? "incompleto"
    : targets.applicableUseful.observed >= 6 &&
        targets.contextPreference.observed >= 5 &&
        targets.noApplication.withoutRecommendation === 2 &&
        targets.citations.unresolved === 0
      ? "metas atingidas"
      : "metas não atingidas";
  const report = {
    generatedAt: new Date().toISOString(),
    preRegisteredAt: sample.preRegisteredAt,
    items,
    targets,
    verdict,
  };
  await writeFile(
    join(__dirname, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        items: items.map(
          ({
            key,
            ran,
            status,
            rating,
            preference,
            citations,
            unresolvedCitations,
          }) => ({
            key,
            ran,
            status,
            rating,
            preference,
            citations,
            unresolvedCitations,
          }),
        ),
        targets,
        verdict,
      },
      null,
      2,
    ),
  );
});
