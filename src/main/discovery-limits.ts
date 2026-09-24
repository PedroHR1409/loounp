/** Truncation and count limits shared by the discovery pipeline (sources.ts + discovery.ts). */
export const limits = {
  examples: {
    maxRatedPerPolarity: 3,
    maxProfilePositive: 5,
    maxProfileNegative: 3,
    maxArchivedPriority: 3,
    maxTotal: 16,
    maxSearchTerms: 4,
    maxProposalInput: 10,
  },
  exampleResolution: {
    maxRawInputChars: 1500,
    maxTitleChars: 500,
    maxExcerptChars: 1000,
  },
  tags: {
    maxDevtoProfile: 12,
    maxDevtoLegacy: 5,
    maxMediumSlugs: 12,
  },
  normalizedContent: {
    maxDescriptionChars: 4000,
    maxExcerptChars: 4000,
  },
  batchAssessment: {
    maxIntentChars: 4000,
    maxTitleChars: 500,
    maxAuthorChars: 160,
    maxDescriptionChars: 2500,
    maxExcerptChars: 4000,
    maxTags: 20,
    maxSignals: 8,
    maxReasonChars: 500,
  },
};
