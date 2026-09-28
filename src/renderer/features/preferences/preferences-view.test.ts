import { describe, expect, it } from "vitest";
import { lastRefreshLabel } from "./preferences-view";

describe("lastRefreshLabel", () => {
  it('retorna "Nenhuma busca ainda." quando nunca houve busca', () => {
    expect(lastRefreshLabel(null)).toBe("Nenhuma busca ainda.");
  });

  it("formata a data da última busca quando existe", () => {
    const label = lastRefreshLabel("2026-09-24T12:00:00.000Z");
    expect(label.startsWith("Última busca: ")).toBe(true);
  });
});
