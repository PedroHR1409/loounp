import { describe, expect, it } from "vitest";
import { coverageSummaryText } from "./context-view";

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
