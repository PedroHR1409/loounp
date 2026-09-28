import { describe, expect, it, vi } from "vitest";
import type { PublicNetworkDeps } from "../security/public-network";
import type OpenAI from "openai";
import {
  assessContentBatch,
  proposeInterestProfile,
  resolveExample,
} from "./content-discovery";
import type { InterestProfileV2 } from "../../core/content-discovery/interest-profile";
import type { NormalizedContent } from "../../core/content-discovery/content";

function profile(
  status: "draft" | "confirmed" = "confirmed",
): InterestProfileV2 {
  return {
    schemaVersion: 2,
    status,
    intentText: "Find practical AI projects",
    interestGroups: [
      {
        id: "ai-projects",
        label: "AI projects",
        summary: "Buildable projects",
        priority: 5,
        objectives: ["build an AI project"],
        subtopics: ["AI agents"],
        retrievalTerms: { devtoTags: ["ai"], mediumTopics: ["ai-agents"] },
      },
    ],
    positiveTraits: ["working examples"],
    deprioritizeTraits: ["promotion without implementation detail"],
    examples: [],
    mediumFeeds: [],
    recencyPreference: 0.5,
    revision: 3,
  };
}

function item(id: string): NormalizedContent {
  return {
    id,
    title: `Build an AI project ${id}`,
    canonicalUrl: `https://example.com/${id}`,
    sourceOccurrences: [
      { source: "devto", originalUrl: `https://example.com/${id}` },
    ],
    tags: ["ai"],
  };
}

function clientReturning(payload: unknown) {
  return {
    responses: {
      create: vi.fn(async () => ({ output_text: JSON.stringify(payload) })),
    },
  } as unknown as OpenAI;
}

describe("AI discovery", () => {
  it("creates a reviewable draft and preserves user-owned source preferences", async () => {
    const client = clientReturning({
      interestGroups: [
        {
          id: "ai-projects",
          label: "AI projects",
          summary: "Practical projects",
          priority: 5,
          objectives: ["build useful AI systems"],
          subtopics: ["agents"],
          retrievalTerms: { devtoTags: ["ai"], mediumTopics: ["ai-agents"] },
        },
      ],
      positiveTraits: ["examples"],
      deprioritizeTraits: ["hype"],
    });
    const draft = await proposeInterestProfile(client, {
      intentText: "Find useful AI projects",
      positiveExamples: ["A working agent tutorial"],
      negativeExamples: ["A vague AI announcement"],
      mediumFeeds: ["https://medium.com/feed/tag/ai"],
      recencyPreference: 0.4,
    });
    expect(draft.status).toBe("draft");
    expect(draft.mediumFeeds).toEqual(["https://medium.com/feed/tag/ai"]);
    expect(draft.examples.map((example) => example.polarity)).toEqual([
      "positive",
      "negative",
    ]);
  });

  it("resolves public metadata only from approved article hosts and falls back without fetching elsewhere", async () => {
    const calls: URL[] = [];
    const network: PublicNetworkDeps = {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (url) => {
        calls.push(url);
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: (async function* () {
            yield Buffer.from(
              '<html><head><meta property="og:title" content="A useful agent guide"><meta name="description" content="A concrete tutorial."></head></html>',
            );
          })(),
          abort: () => undefined,
        };
      },
    };
    const resolved = await resolveExample(
      "https://levelup.gitconnected.com/example",
      network,
    );
    expect(resolved.title).toBe("A useful agent guide");
    expect(resolved.excerpt).toBe("A concrete tutorial.");
    expect(calls).toHaveLength(1);

    const fallback = await resolveExample(
      "https://unapproved.example/article",
      network,
    );
    expect(fallback.title).toBe("https://unapproved.example/article");
    expect(calls).toHaveLength(1);
  });

  it("withholds all results for an unconfirmed profile", async () => {
    const client = clientReturning({ assessments: [] });
    expect(
      await assessContentBatch(client, profile("draft"), [item("one")]),
    ).toEqual([undefined]);
    expect(client.responses.create).not.toHaveBeenCalled();
  });

  it("assesses per-user utility separately from topic fit and stamps the current profile revision", async () => {
    const client = clientReturning({
      assessments: [
        {
          id: "one",
          groupMatches: [{ groupId: "ai-projects", fit: 0.9 }],
          personalUtility: 0.15,
          contentType: "announcement",
          technicalDepth: "low",
          signals: [
            {
              code: "few-details",
              evidence: "Only a short launch note is provided.",
            },
          ],
          confidence: 0.7,
          reason: "It matches AI projects but offers little practical detail.",
        },
      ],
    });
    const [assessment] = await assessContentBatch(client, profile(), [
      item("one"),
    ]);
    expect(assessment?.personalUtility).toBe(0.15);
    expect(assessment?.groupMatches[0].fit).toBe(0.9);
    expect(assessment?.profileRevision).toBe(3);
    expect(assessment?.reason).toContain("little practical detail");
  });

  it("leaves an omitted item unassessed instead of allowing it into the feed", async () => {
    const client = clientReturning({ assessments: [] });
    expect(await assessContentBatch(client, profile(), [item("one")])).toEqual([
      undefined,
    ]);
  });
});
