import { describe, expect, it } from "vitest";
import {
  buildGenerationPayload,
  ContractError,
  parseAuthorizeInput,
  parseModelJson,
  parseRemoveItemInput,
  parseSetPurposeInput,
  parseStartInput,
  transition,
  validateRecommendation,
  type ContextPackage,
} from "./project-ideas";

const hash = "a".repeat(64);

function contextPackage(
  overrides: Partial<ContextPackage> = {},
): ContextPackage {
  return {
    id: "pkg_00000001",
    operationId: "op_00000001",
    contract: "v1",
    articleSha256: hash,
    articleCoverage: "main_text",
    items: [
      {
        id: "itm_article01",
        kind: "article",
        label: "Artigo",
        text: "Como usar busca híbrida com BM25 e grafos para localizar componentes.",
      },
      {
        id: "itm_evidence1",
        kind: "evidence",
        label: "radar/README.md",
        text: "O ranking atual usa regras explicáveis e não calcula embeddings.",
        sourceVersionId: "src_00000001",
        sha256: hash,
      },
      {
        id: "itm_memory001",
        kind: "memory",
        label: "Objetivo confirmado",
        text: "Quero projetos práticos de dados.",
        memoryId: "mem_00000001",
        memoryRevision: 1,
      },
    ],
    memoryGlobalRevision: 1,
    provider: "openai",
    model: "gpt-5.6-luna",
    purpose: "practical",
    payloadSha256: hash,
    estimatedTokens: 200,
    callBudget: 2,
    reviewToken: hash,
    createdAt: "2026-09-23T12:00:00.000Z",
    projectsConsulted: true,
    notices: [],
    ...overrides,
  };
}

const projects = new Map([["prj_radar0001", "radar"]]);

describe("operation state machine", () => {
  it("follows the designed flow and allows failure or cancellation from operational states", () => {
    let state = transition("created", "acquiring_article");
    state = transition(state, "retrieving_context");
    state = transition(state, "awaiting_consent");
    state = transition(state, "generating");
    state = transition(state, "validating");
    expect(transition(state, "completed")).toBe("completed");
    expect(transition("generating", "canceled")).toBe("canceled");
    expect(() => transition("completed", "failed")).toThrow("encerrada");
    expect(() => transition("created", "generating")).toThrow("inválida");
  });
});

describe("IPC contracts", () => {
  it("rejects unknown fields on authorization and malformed ids", () => {
    expect(() =>
      parseAuthorizeInput({
        operationId: "op_00000001",
        packageId: "pkg_00000001",
        reviewToken: hash,
        payloadSha256: hash,
        approved: true,
      }),
    ).toThrow("desconhecidos");
    expect(() =>
      parseAuthorizeInput({
        operationId: "../etc",
        packageId: "pkg_00000001",
        reviewToken: hash,
        payloadSha256: hash,
      }),
    ).toThrow(ContractError);
    expect(
      parseAuthorizeInput({
        operationId: "op_00000001",
        packageId: "pkg_00000001",
        reviewToken: hash,
        payloadSha256: hash,
      }).packageId,
    ).toBe("pkg_00000001");
  });

  it("accepts exactly one article source, or a feed item with pasted text", () => {
    expect(() => parseStartInput({ purpose: "both" })).toThrow("informe");
    expect(parseStartInput({ contentId: "devto:1" }).purpose).toBeUndefined();
    expect(() =>
      parseStartInput({
        url: "https://example.com/a",
        contentId: "x",
        purpose: "both",
      }),
    ).toThrow("informe");
    expect(
      parseStartInput({
        contentId: "devto:1",
        text: "x".repeat(250),
        purpose: "portfolio",
      }).text,
    ).toHaveLength(250);
    expect(() =>
      parseRemoveItemInput({
        operationId: "op_00000001",
        packageId: "pkg_00000001",
        itemId: "C:\\Users\\x",
        scope: "once",
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseRemoveItemInput({
        operationId: "op_00000001",
        packageId: "pkg_00000001",
        itemId: "itm_00000001",
        scope: "forever",
      }),
    ).toThrow(ContractError);
    expect(() =>
      parseSetPurposeInput({
        operationId: "op_00000001",
        packageId: "pkg_00000001",
        purpose: "fun",
      }),
    ).toThrow(ContractError);
  });
});

describe("generation payload", () => {
  it("marks every source as untrusted data and states whether projects were consulted", () => {
    const payload = buildGenerationPayload(
      contextPackage({ projectsConsulted: false }),
    );
    expect(payload.instructions).toContain("não confiável");
    expect(payload.input).toContain("Projetos locais consultados: não");
    expect(payload.input).toContain(
      '<dados id="itm_evidence1" tipo="evidence"',
    );
    expect(payload).not.toHaveProperty("tools");
  });
});

describe("recommendation validation", () => {
  it("accepts a grounded improvement with literal quotes and known ids", () => {
    const raw = parseModelJson(
      "```json\n" +
        JSON.stringify({
          status: "recommendation",
          modality: "improvement",
          targetProjectId: "prj_radar0001",
          title: "Busca híbrida no Radar",
          description: "Adicionar BM25 ao ranking.",
          firstVersion: "Índice lexical local",
          effort: null,
          stack: [{ name: "TypeScript", justification: "Já usado no projeto" }],
          reasons: [
            {
              text: "O ranking não usa embeddings",
              evidenceIds: ["itm_evidence1"],
              inferred: false,
              quote: "não calcula embeddings",
            },
          ],
          limitations: [],
        }) +
        "\n```",
    );
    const result = validateRecommendation(raw, contextPackage(), projects);
    expect(result.status).toBe("recommendation");
    expect(result.reasons[0].inferred).toBe(false);
    expect(result.citedEvidence[0]).toMatchObject({
      id: "itm_evidence1",
      sourceVersionId: "src_00000001",
    });
  });

  it("fails explicitly on invented evidence or foreign target projects", () => {
    const base = {
      status: "recommendation",
      modality: "improvement",
      targetProjectId: "prj_radar0001",
      title: "t",
      description: "d",
      reasons: [{ text: "r", evidenceIds: ["itm_evidence1"] }],
    };
    expect(() =>
      validateRecommendation(
        { ...base, reasons: [{ text: "r", evidenceIds: ["itm_missing01"] }] },
        contextPackage(),
        projects,
      ),
    ).toThrow("inexistente");
    expect(() =>
      validateRecommendation(
        { ...base, targetProjectId: "prj_other0001" },
        contextPackage(),
        projects,
      ),
    ).toThrow("Projeto-alvo");
  });

  it("keeps the idea when a quote does not match and marks that reason as inference", () => {
    const base = {
      status: "recommendation",
      modality: "improvement",
      targetProjectId: "prj_radar0001",
      title: "t",
      description: "d",
    };
    const invented = validateRecommendation(
      {
        ...base,
        reasons: [
          {
            text: "r",
            evidenceIds: ["itm_evidence1"],
            inferred: false,
            quote: "usa Kafka em produção",
          },
        ],
      },
      contextPackage(),
      projects,
    );
    expect(invented.status).toBe("recommendation");
    expect(invented.reasons[0]).toMatchObject({
      evidenceIds: ["itm_evidence1"],
      inferred: true,
    });
    const punctuation = validateRecommendation(
      {
        ...base,
        reasons: [
          {
            text: "r",
            evidenceIds: ["itm_evidence1"],
            inferred: false,
            quote: "“Não  calcula — embeddings…”",
          },
        ],
      },
      contextPackage(),
      projects,
    );
    expect(punctuation.reasons[0].inferred).toBe(false);
  });

  it("keeps plain-language summary and explained terms, dropping terms without explanation", () => {
    const result = validateRecommendation(
      {
        status: "recommendation",
        modality: "improvement",
        targetProjectId: "prj_radar0001",
        title: "t",
        summary: "Resumo simples",
        description: "d",
        reasons: [{ text: "r", evidenceIds: ["itm_evidence1"] }],
        terms: [
          {
            name: "Pydantic",
            explanation:
              "Biblioteca que confere se os dados têm o formato certo.",
          },
          { name: "BM25", explanation: "" },
        ],
      },
      contextPackage(),
      projects,
    );
    expect(result.summary).toBe("Resumo simples");
    expect(result.terms).toEqual([
      {
        name: "Pydantic",
        explanation: "Biblioteca que confere se os dados têm o formato certo.",
      },
    ]);
    const payload = buildGenerationPayload(contextPackage());
    expect(payload.instructions).toContain("iniciante");
    expect(payload.instructions).toContain('"terms"');
  });

  it("treats insufficient context and no application as product outcomes that require a reason (AT-08)", () => {
    expect(
      validateRecommendation(
        {
          status: "no_application",
          limitations: ["O artigo é um anúncio sem técnica aplicável."],
        },
        contextPackage(),
        projects,
      ).status,
    ).toBe("no_application");
    expect(() =>
      validateRecommendation(
        { status: "insufficient_context", limitations: [] },
        contextPackage(),
        projects,
      ),
    ).toThrow("motivo");
    expect(() => parseModelJson("not json")).toThrow("JSON");
  });
});
