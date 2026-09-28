import { describe, expect, it } from "vitest";
import {
  fetchDevto,
  fetchMedium,
  withBehavioralExamples,
  type ConfirmedInterestProfile,
} from "./sources";
import type { PublicNetworkDeps } from "../security/public-network";

function mockFeedNetwork(
  respond: (url: URL) => {
    status: number;
    body: string;
    headers?: Record<string, string | string[] | undefined>;
  },
) {
  const calls: string[] = [];
  const deps: PublicNetworkDeps = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (url) => {
      calls.push(url.toString());
      const result = respond(url);
      return {
        status: result.status,
        headers: result.headers ?? {},
        body: (async function* () {
          if (result.body) yield Buffer.from(result.body);
        })(),
        abort: () => undefined,
      };
    },
  };
  return { deps, calls };
}

describe("source connectors", () => {
  it("maps legacy topics to Dev.to tags and deduplicates normalized articles", async () => {
    const network = mockFeedNetwork(() => ({
      status: 200,
      body: JSON.stringify([
            {
              id: 42,
              title: "Building AI agents",
              url: "https://dev.to/example/building-ai-agents?utm_source=feed",
              canonical_url:
                "https://dev.to/example/building-ai-agents?utm_source=feed",
              user: { name: "Example Author" },
              published_at: "2026-09-19T12:00:00Z",
              description: "A technical guide to agents.",
              tag_list: ["ai", "agents"],
            },
          ]),
    }));

    const articles = await fetchDevto(["Artificial Intelligence"], network.deps);

    expect(network.calls).toHaveLength(2);
    expect(
      new URL(network.calls[0]).searchParams.get("tag"),
    ).toBe("ai");
    expect(articles).toHaveLength(1);
    expect(articles[0].sourceOccurrences[0].source).toBe("devto");
    expect(articles[0].canonicalUrl).toBe(
      "https://dev.to/example/building-ai-agents",
    );
  });

  it("derives normalized Dev.to tags only from a confirmed profile and tolerates a failed tag", async () => {
    const profile: ConfirmedInterestProfile = {
      status: "confirmed",
      retrievalTerms: { devtoTags: ["Data Engineering", "dataengineering"] },
      interestGroups: [
        {
          subtopics: ["Fabric"],
          retrievalTerms: { devtoTags: ["data-engineering"] },
        },
      ],
    };
    const network = mockFeedNetwork((url) => {
      const tag = url.searchParams.get("tag");
      if (tag === "fabric") return { status: 503, body: "unavailable" };
      return {
        status: 200,
        body: JSON.stringify([
          {
            id: 7,
            title: "Data pipelines",
            url: "https://dev.to/a/pipelines",
            canonical_url: "https://dev.to/a/pipelines",
            tag_list: ["dataengineering"],
          },
        ]),
      };
    });

    const articles = await fetchDevto(profile, network.deps);
    const queriedTags = network.calls.map((input) =>
      new URL(input).searchParams.get("tag"),
    );

    expect(queriedTags).toEqual(["dataengineering", "fabric"]);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Data pipelines");
  });

  it("uses positive example titles as a small adjacent discovery lane, not negative examples", async () => {
    const profile: ConfirmedInterestProfile = {
      status: "confirmed",
      retrievalTerms: { devtoTags: ["dataengineering", "fabric"] },
      interestGroups: [],
      examples: [
        {
          polarity: "positive",
          title: "Building an AI agent harness with Scala Spark",
        },
        { polarity: "negative", title: "Claude hype roundup" },
      ],
    };
    const network = mockFeedNetwork(() => ({ status: 200, body: "[]" }));

    await fetchDevto(profile, network.deps);
    const queriedTags = network.calls.map((input) =>
      new URL(input).searchParams.get("tag"),
    );

    expect(queriedTags).toEqual([
      "dataengineering",
      "fabric",
      "ai",
      "agent",
      "harness",
      "scala",
    ]);
  });

  it("puts recent explicit useful ratings ahead of broad imported history for retrieval expansion", () => {
    const profile: ConfirmedInterestProfile = {
      status: "confirmed",
      interestGroups: [],
      examples: [
        { polarity: "negative", title: "Hype list" },
        { polarity: "positive", title: "Manual example" },
        { polarity: "positive", title: "Rated not useful one" },
      ],
    };
    const expanded = withBehavioralExamples(
      profile,
      [
        "Rated useful one",
        "Rated useful two",
        "Rated useful three",
        "Rated useful four",
      ],
      ["Rated not useful one"],
      ["Clapped archive article", "Saved archive article"],
    );

    expect(
      expanded.examples?.slice(0, 3).map((example) => example.title),
    ).toEqual(["Rated useful one", "Rated useful two", "Rated useful three"]);
    expect(
      expanded.examples?.some(
        (example) =>
          example.title === "Hype list" && example.polarity === "negative",
      ),
    ).toBe(true);
    expect(
      expanded.examples?.some(
        (example) => example.title === "Rated useful four",
      ),
    ).toBe(false);
    expect(
      expanded.examples?.find(
        (example) => example.title === "Rated not useful one",
      )?.polarity,
    ).toBe("negative");
  });

  it("suppresses terms repeated in negative examples while preserving declared topic queries", async () => {
    const profile: ConfirmedInterestProfile = {
      status: "confirmed",
      retrievalTerms: { devtoTags: ["claude"] },
      interestGroups: [],
      examples: [
        { polarity: "positive", title: "Claude code architecture graphify" },
        { polarity: "negative", title: "Claude code marketing hype" },
      ],
    };
    const network = mockFeedNetwork(() => ({ status: 200, body: "[]" }));

    await fetchDevto(profile, network.deps);
    const queriedTags = network.calls.map((input) =>
      new URL(input).searchParams.get("tag"),
    );

    expect(queriedTags).toEqual(["claude", "architecture", "graphify"]);
    expect(queriedTags).not.toContain("code");
  });

  it("does not use draft profile terms", async () => {
    const network = mockFeedNetwork(() => ({ status: 200, body: "[]" }));

    await expect(
      fetchDevto({
        status: "draft",
        interestGroups: [{ subtopics: ["AI"] }],
      } as unknown as ConfirmedInterestProfile, network.deps),
    ).resolves.toEqual([]);
    expect(network.calls).toEqual([]);
  });

  it("reads Medium RSS metadata and keeps the article as a normalized occurrence", async () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>Practical LLM systems</title><link>https://medium.com/@author/practical-llm-systems?source=rss</link><description><![CDATA[<p>A field guide to building reliable systems.</p>]]></description><category>llm</category><dc:creator>Example Writer</dc:creator><pubDate>Sat, 19 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
    const network = mockFeedNetwork(() => ({ status: 200, body: xml }));

    const articles = await fetchMedium(
      ["https://medium.com/feed/tag/llm"],
      undefined,
      network.deps,
    );

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Practical LLM systems");
    expect(articles[0].author).toBe("Example Writer");
    expect(articles[0].canonicalUrl).toBe(
      "https://medium.com/@author/practical-llm-systems",
    );
    expect(articles[0].tags).toContain("llm");
  });

  it("adds deduplicated Medium topic RSS feeds from confirmed profile while preserving configured feeds", async () => {
    const profile: ConfirmedInterestProfile = {
      status: "confirmed",
      interestGroups: [
        {
          subtopics: ["Data Engineering"],
          retrievalTerms: { mediumTopics: ["ai-agents"] },
        },
      ],
    };
    const network = mockFeedNetwork(() => ({
      status: 200,
      body: "<rss><channel></channel></rss>",
    }));

    await fetchMedium(
      ["https://medium.com/feed/tag/data-engineering"],
      profile,
      network.deps,
    );

    expect(network.calls).toEqual([
      "https://medium.com/feed/tag/data-engineering",
      "https://medium.com/feed/tag/ai-agents",
    ]);
  });

  it("keeps successful Medium feeds when another configured feed fails", async () => {
    const network = mockFeedNetwork((url) =>
      url.pathname.includes("/broken")
        ? { status: 503, body: "unavailable" }
        : {
            status: 200,
            body: "<rss><channel><item><title>Successful</title><link>https://medium.com/@a/story</link></item></channel></rss>",
          },
    );

    const articles = await fetchMedium([
      "https://medium.com/feed/tag/good",
      "https://medium.com/broken",
    ], undefined, network.deps);

    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Successful");
  });

  it("accepts a non-Medium HTTPS feed and tags its items with the rss source", async () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>A generic RSS post</title><link>https://example.com/posts/generic</link><description>A post from a generic feed.</description></item></channel></rss>`;
    const network = mockFeedNetwork(() => ({ status: 200, body: xml }));

    const articles = await fetchMedium(
      ["https://example.com/rss.xml"],
      undefined,
      network.deps,
    );

    expect(articles).toHaveLength(1);
    expect(articles[0].sourceOccurrences[0].source).toBe("rss");
    expect(articles[0].id).toBe("rss:https://example.com/posts/generic");
  });

  it("rejects a feed URL on a private/loopback host before requesting it", async () => {
    const network = mockFeedNetwork(() => ({ status: 200, body: "" }));
    await expect(
      fetchMedium(["https://127.0.0.1/feed.xml"], undefined, network.deps),
    ).rejects.toThrow("rede privada/local");
    expect(network.calls).toEqual([]);
  });

  it("follows a bounded redirect that stays on the same host", async () => {
    const network = mockFeedNetwork((url) =>
      url.pathname.endsWith("/start")
        ? {
            status: 302,
            body: "",
            headers: { location: "/feed/tag/agents" },
          }
        : { status: 200, body: "<rss><channel></channel></rss>" },
    );

    await expect(
      fetchMedium(["https://medium.com/start"], undefined, network.deps),
    ).resolves.toEqual([]);
    expect(network.calls).toHaveLength(2);
  });

  it("follows a bounded redirect across public hosts", async () => {
    const network = mockFeedNetwork((url) =>
      url.toString() === "https://medium.com/feed/tag/ai"
        ? {
            status: 302,
            body: "",
            headers: { location: "https://example.com/feed.xml" },
          }
        : { status: 200, body: "<rss><channel></channel></rss>" },
    );

    await expect(
      fetchMedium(["https://medium.com/feed/tag/ai"], undefined, network.deps),
    ).resolves.toEqual([]);
    expect(network.calls).toHaveLength(2);
  });

  it("rejects a redirect to a private/loopback host and oversized feed bodies", async () => {
    const privateNetwork = mockFeedNetwork(() => ({
      status: 302,
      body: "",
      headers: { location: "https://127.0.0.1/feed.xml" },
    }));
    await expect(
      fetchMedium(
        ["https://medium.com/feed/tag/ai"],
        undefined,
        privateNetwork.deps,
      ),
    ).rejects.toThrow("host não permitido");
    expect(privateNetwork.calls).toHaveLength(1);

    const oversizedNetwork = mockFeedNetwork(() => ({
      status: 200,
      body: "x".repeat(2 * 1024 * 1024 + 1),
    }));
    await expect(
      fetchMedium(
        ["https://medium.com/feed/tag/ai"],
        undefined,
        oversizedNetwork.deps,
      ),
    ).rejects.toThrow("excede 2 MiB");
  });
});
