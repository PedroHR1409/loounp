import { describe, expect, it } from "vitest";
import {
  cardPendingLabel,
  pendingTermsSummaryLabel,
  termKnowledgeState,
} from "./ideas-view";

const term = (knowledge: IdeaTermView["knowledge"]): IdeaTermView => ({
  name: "RAG",
  explanation: "",
  knowledge,
});

const historyItem: IdeaHistoryItem = {
  operationId: "op_1",
  title: "Ideia",
  modality: "new",
  purpose: "both",
  createdAt: "2026-09-20T12:00:00.000Z",
  articleTitle: "Artigo",
  contentId: null,
  rating: null,
  contextRevoked: false,
  pendingTermsCount: 0,
};

describe("termKnowledgeState", () => {
  it("pede para perguntar quando não há memória", () => {
    expect(termKnowledgeState(term(null))).toEqual({
      kind: "ask",
      question: "Você já conhece ou já usou RAG?",
    });
  });

  it("pede para reconfirmar quando a memória diz que não conhecia", () => {
    const state = termKnowledgeState(
      term({ memoryId: "m1", known: false, text: "não conhecia" }),
    );
    expect(state).toEqual({
      kind: "recheck",
      question:
        'Na memória "não conhecia" você disse que não conhecia. Já sabe o que é?',
    });
  });

  it('é "known" quando a memória diz que já conhece', () => {
    expect(
      termKnowledgeState(term({ memoryId: "m1", known: true, text: "já sei" })),
    ).toEqual({ kind: "known" });
  });
});

describe("cardPendingLabel", () => {
  it("retorna null quando não há termos pendentes (AT-004)", () => {
    expect(
      cardPendingLabel({ ...historyItem, pendingTermsCount: 0 }),
    ).toBeNull();
  });

  it("usa singular para 1 termo pendente", () => {
    expect(cardPendingLabel({ ...historyItem, pendingTermsCount: 1 })).toBe(
      "1 termo pendente",
    );
  });

  it("usa plural para mais de 1 termo pendente", () => {
    expect(cardPendingLabel({ ...historyItem, pendingTermsCount: 3 })).toBe(
      "3 termos pendentes",
    );
  });
});

describe("pendingTermsSummaryLabel", () => {
  it("soma os pendentes de todas as ideias (AT-005)", () => {
    const items = [
      { ...historyItem, pendingTermsCount: 3 },
      { ...historyItem, pendingTermsCount: 0 },
      { ...historyItem, pendingTermsCount: 2 },
    ];
    expect(pendingTermsSummaryLabel(items)).toBe(
      "Você tem 5 termos pendentes de resposta.",
    );
  });

  it("retorna null quando a soma é zero", () => {
    const items = [
      { ...historyItem, pendingTermsCount: 0 },
      { ...historyItem, pendingTermsCount: 0 },
    ];
    expect(pendingTermsSummaryLabel(items)).toBeNull();
  });
});
