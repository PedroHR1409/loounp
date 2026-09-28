import { describe, expect, it } from "vitest";
import { coverageSummaryText, semanticRerankControl } from "./context-view";

describe("semanticRerankControl", () => {
  it("oferece ligar e explica o que é enviado quando está desligado", () => {
    const control = semanticRerankControl({ enabled: false, available: true });
    expect(control.label).toBe("Ligar busca por significado");
    expect(control.next).toBe(true);
    expect(control.note).toContain("antes da tela de revisão");
    expect(control.note).not.toContain("chave OpenAI");
  });

  it("oferece desligar sem repetir a explicação quando está ligado", () => {
    expect(
      semanticRerankControl({ enabled: true, available: true }),
    ).toEqual({
      label: "Desligar busca por significado",
      next: false,
      note: null,
    });
  });

  it("avisa que precisa de chave quando não há gateway com embeddings", () => {
    const off = semanticRerankControl({ enabled: false, available: false });
    expect(off.note).toContain("Envia o artigo");
    expect(off.note).toContain("Precisa de uma chave OpenAI configurada.");
    expect(
      semanticRerankControl({ enabled: true, available: false }).note,
    ).toBe("Precisa de uma chave OpenAI configurada.");
  });
});

describe("coverageSummaryText", () => {
  it('retorna "ainda não catalogado" quando não há catálogo', () => {
    expect(coverageSummaryText(null)).toBe(
      "Desktop\\Projetos · ainda não catalogado",
    );
  });

  it("formata contagens e data quando há catálogo", () => {
    const lastCatalog: ProjectContextStatus["lastCatalog"] = {
      at: "2026-09-20T12:00:00.000Z",
      coverage: {
        cataloged: 120,
        consulted: 118,
        excluded: 2,
        pending: 0,
        secretBlockedChunks: 3,
        skippedDirectories: 0,
        partial: false,
        graphStatus: {},
      },
    };
    const text = coverageSummaryText(lastCatalog);
    expect(text).toContain("118 arquivos lidos");
    expect(text).toContain("2 excluídos");
    expect(text).toContain("3 trechos com segredo bloqueados");
  });
});
