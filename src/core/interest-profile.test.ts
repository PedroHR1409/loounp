import assert from "node:assert/strict";
import { test } from "vitest";

import {
  activeProfile,
  adaptLegacyProfile,
  isInterestProfileV2,
  normalizeInterestProfile,
  type InterestProfileV2,
} from "./interest-profile";

const validProfile: InterestProfileV2 = {
  schemaVersion: 2,
  status: "draft",
  intentText: "Learn data engineering",
  interestGroups: [
    {
      id: "data-engineering",
      label: "Data engineering",
      summary: "Reliable data pipelines",
      priority: 5,
      objectives: ["Build data pipelines"],
      subtopics: ["Spark", "dbt"],
      retrievalTerms: {
        devtoTags: ["Spark"],
        mediumTopics: ["data-engineering"],
      },
    },
  ],
  positiveTraits: ["Practical examples"],
  deprioritizeTraits: ["Hype without evidence"],
  examples: [
    {
      polarity: "positive",
      url: "https://medium.com/example",
      title: "A useful guide",
      excerpt: "A short excerpt",
    },
  ],
  mediumFeeds: ["https://medium.com/feed/tag/data-engineering"],
  recencyPreference: 0.7,
  revision: 2,
};

test("normalizes and validates the bounded v2 profile contract", () => {
  const profile = normalizeInterestProfile({
    ...validProfile,
    interestGroups: [
      { ...validProfile.interestGroups[0], label: "  Data engineering  " },
    ],
  });
  assert.equal(profile.interestGroups[0].label, "Data engineering");
  assert.deepEqual(profile.interestGroups[0].retrievalTerms.devtoTags, [
    "spark",
  ]);
  assert.ok(isInterestProfileV2(profile));
});

test("rejects excessive groups, invalid priorities, unsafe feeds, and oversized examples", () => {
  assert.throws(
    () =>
      normalizeInterestProfile({
        ...validProfile,
        interestGroups: Array(13).fill(validProfile.interestGroups[0]),
      }),
    /at most 12 groups/,
  );
  assert.throws(
    () =>
      normalizeInterestProfile({
        ...validProfile,
        interestGroups: [{ ...validProfile.interestGroups[0], priority: 6 }],
      }),
    /priority/,
  );
  assert.throws(
    () =>
      normalizeInterestProfile({
        ...validProfile,
        mediumFeeds: ["http://medium.com/feed"],
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      normalizeInterestProfile({
        ...validProfile,
        examples: [
          { polarity: "negative", title: "x".repeat(1501), excerpt: "" },
        ],
      }),
    /characters/,
  );
  assert.equal(isInterestProfileV2({ schemaVersion: 2 }), false);
});

test("adapts legacy topics and feeds into a reviewable draft without replacing the active legacy profile", () => {
  const legacy = {
    topics: [{ topic: "Data Engineering", importance: 0.8 }],
    mediumFeeds: ["https://medium.com/feed/@reader"],
    recencyPreference: 0.6,
  };
  const draft = adaptLegacyProfile(legacy);

  assert.equal(draft.status, "draft");
  assert.equal(draft.interestGroups[0].label, "Data Engineering");
  assert.deepEqual(draft.mediumFeeds, legacy.mediumFeeds);
  assert.deepEqual(activeProfile(draft, legacy), {
    topics: legacy.topics,
    recencyPreference: 0.6,
  });
  assert.equal(
    (
      activeProfile(
        { ...draft, status: "confirmed" },
        legacy,
      ) as InterestProfileV2
    ).status,
    "confirmed",
  );
});
