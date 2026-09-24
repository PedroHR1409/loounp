import { describe, expect, it, vi } from "vitest";
import { assessWithTypeSafe, createJevAssessment } from "./typesafe-jev";

const utilityLegend = [
  "Only broad topic overlap or no clear connection to the user’s learning goals.",
  "Some useful connection, but applicability or learning is limited.",
  "Directly supports the user’s goals or offers applicable practical learning.",
];
const depthLegend = [
  "Headline or claim with little technical evidence.",
  "Describes a process, method, partial implementation, or trade-offs.",
  "Shows substantial mechanisms, architecture, code, evaluation, constraints, or trade-offs.",
];
const score = (
  legend: string[],
  result: {
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
  },
) => ({
  type: "score",
  ...result,
  legend: Object.fromEntries(
    legend.map((value, index) => [String(index), value]),
  ),
});
const goodAnswer = {
  utility: score(utilityLegend, {
    score: 1.7,
    confidence: 0.82,
    probabilities: { "0": 0.05, "1": 0.2, "2": 0.75 },
  }),
  technical_depth: score(depthLegend, {
    score: 1.1,
    confidence: 0.7,
    probabilities: { "0": 0.15, "1": 0.6, "2": 0.25 },
  }),
};
function fetchReturning(answer: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ model: "jev-latest", answers: answer }), {
        status,
      }),
  ) as unknown as typeof fetch;
}

describe("TypeSafe Jev Score adapter", () => {
  it("sends two independent ordered Score questions and preserves score, legend, probabilities and confidence", async () => {
    const fetcher = fetchReturning(goodAnswer);
    const result = await assessWithTypeSafe(
      "typesafe-test-key",
      "Article context",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
    const request = JSON.parse(
      String(vi.mocked(fetcher).mock.calls[0][1]?.body),
    );
    expect(request.questions.utility.type).toBe("score");
    expect(request.questions.utility.criteria).toHaveLength(3);
    expect(request.questions.technical_depth.type).toBe("score");
    expect(request.questions.technical_depth.criteria).toHaveLength(3);
    expect(result.utility).toMatchObject({
      score: 1.7,
      confidence: 0.82,
      level: "high",
      probabilities: goodAnswer.utility.probabilities,
    });
    expect(result.technicalDepth).toMatchObject({
      score: 1.1,
      confidence: 0.7,
      level: "medium",
    });
    const stored = createJevAssessment(result, 4, "fingerprint");
    expect(stored).toMatchObject({
      provider: "typesafe",
      model: "jev-latest",
      rubricVersion: "jev-product-decisions-v1",
      profileRevision: 4,
      contentFingerprint: "fingerprint",
      status: "valid",
    });
  });

  it("keeps a single valid dimension as an explicit partial result", async () => {
    const result = await assessWithTypeSafe(
      "key",
      "state",
      fetchReturning({ utility: goodAnswer.utility }),
    );
    expect(result.utility).toBeDefined();
    expect(result.technicalDepth).toBeUndefined();
    expect(createJevAssessment(result, 1, "fp").status).toBe("partial");
  });

  it("rejects score inconsistencies, malformed probabilities and incorrect legends", async () => {
    const invalid = { ...goodAnswer.utility, score: 0.1 };
    await expect(
      assessWithTypeSafe(
        "key",
        "state",
        fetchReturning({
          utility: invalid,
          technical_depth: goodAnswer.technical_depth,
        }),
      ),
    ).rejects.toThrow("Scores Jev inválidos");
    const badProbabilities = {
      ...goodAnswer.utility,
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.1 },
    };
    await expect(
      assessWithTypeSafe(
        "key",
        "state",
        fetchReturning({
          utility: badProbabilities,
          technical_depth: goodAnswer.technical_depth,
        }),
      ),
    ).rejects.toThrow("Scores Jev inválidos");
    const badLegend = {
      ...goodAnswer.utility,
      legend: { "0": "High", "1": "Partial", "2": "Low" },
    };
    await expect(
      assessWithTypeSafe(
        "key",
        "state",
        fetchReturning({
          utility: badLegend,
          technical_depth: goodAnswer.technical_depth,
        }),
      ),
    ).rejects.toThrow("Scores Jev inválidos");
  });

  it("maps HTTP 403 to the early-access guidance", async () => {
    await expect(
      assessWithTypeSafe("key", "state", fetchReturning({}, 403)),
    ).rejects.toThrow("acesso à API do Jev");
  });
});
