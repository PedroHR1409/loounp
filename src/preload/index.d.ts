export {};

declare global {
  interface Window {
    contentApp: {
      getState: () => Promise<AppState>;
      saveProfile: (profile: UserProfile) => Promise<void>;
      proposeProfile: (
        input: ProfileProposalInput,
      ) => Promise<InterestProfileV2>;
      confirmProfile: (profile: InterestProfileV2) => Promise<void>;
      refresh: () => Promise<{
        added: number;
        errors: string[];
        stats: DiscoveryStats;
      }>;
      recordFeedback: (
        contentId: string,
        action: string,
        value?: string,
      ) => Promise<void>;
      openLink: (url: string) => Promise<void>;
      analyze: (contentId: string) => Promise<void>;
      setApiKey: (apiKey: string) => Promise<void>;
      clearApiKey: () => Promise<void>;
      setJevKey: (apiKey: string) => Promise<void>;
      clearJevKey: () => Promise<void>;
      previewMediumArchive: () => Promise<MediumArchivePreview | null>;
      importMediumArchive: () => Promise<{
        imported: number;
        learnedFrom: number;
      }>;
      exportData: () => Promise<{ path: string; counts: BackupCounts } | null>;
      previewDataImport: () => Promise<{
        exportedAt: string;
        appVersion: string;
        counts: BackupCounts;
      } | null>;
      commitDataImport: () => Promise<{
        backups: string[];
        counts: BackupCounts;
      }>;
    };
    projectIdeas: {
      start: (input: {
        contentId?: string;
        url?: string;
        text?: string;
        title?: string;
        purpose?: IdeaPurpose;
      }) => Promise<IdeaView>;
      submitText: (input: {
        operationId: string;
        text: string;
      }) => Promise<IdeaView>;
      getStatus: () => Promise<IdeaView | null>;
      cancel: (operationId: string) => Promise<IdeaView>;
      removeItem: (input: {
        operationId: string;
        packageId: string;
        itemId: string;
        scope: "once" | "always";
      }) => Promise<IdeaView>;
      setPurpose: (input: {
        operationId: string;
        packageId: string;
        purpose: IdeaPurpose;
      }) => Promise<IdeaView>;
      rebuild: (operationId: string) => Promise<IdeaView>;
      view: (operationId: string) => Promise<IdeaView>;
      history: (purpose?: IdeaPurpose) => Promise<IdeaHistoryItem[]>;
      deleteIdea: (operationId: string) => Promise<IdeaHistoryItem[]>;
      ignored: () => Promise<IgnoredSourceView[]>;
      unignore: (id: string) => Promise<IgnoredSourceView[]>;
      setMemoryIgnored: (
        memoryId: string,
        ignored: boolean,
      ) => Promise<MemoryListView>;
      onEvent: (callback: (event: IdeaEvent) => void) => () => void;
      authorize: (input: {
        operationId: string;
        packageId: string;
        reviewToken: string;
        payloadSha256: string;
      }) => Promise<IdeaView>;
      deny: (operationId: string) => Promise<IdeaView>;
      rate: (input: {
        operationId: string;
        score: number;
        comment?: string;
        clearLanguage?: boolean;
      }) => Promise<IdeaView>;
      setModel: (input: {
        model: string;
        contextTokens: number;
      }) => Promise<IdeaModelConfig>;
      startComparison: (operationId: string) => Promise<IdeaView>;
      comparison: (operationId: string) => Promise<ComparisonView>;
      recordPreference: (
        evaluationId: string,
        choice: "A" | "B" | "tie",
      ) => Promise<ComparisonView>;
      refreshContext: (input: { projectIds?: string[] }) => Promise<{
        coverage: CatalogCoverageView;
        status: ProjectContextStatus;
      }>;
      contextStatus: () => Promise<ProjectContextStatus>;
      readEvidence: (
        operationId: string,
        itemId: string,
      ) => Promise<{
        label: string;
        text: string;
        historical: boolean;
        version: {
          sha256: string;
          modifiedAt: string;
          relativePath: string;
        } | null;
      }>;
      removeProjectContext: (
        projectId: string,
      ) => Promise<ProjectContextStatus>;
      setRealSources: (enabled: boolean) => Promise<ProjectContextStatus>;
      listMemory: () => Promise<MemoryListView>;
      answerKnowledge: (
        term: string,
        known: boolean,
      ) => Promise<{ memoryId: string; known: boolean; text: string } | null>;
      proposeMemory: (input: {
        kind?: MemoryKindName;
        text?: string;
        fromInterests?: true;
      }) => Promise<MemoryListView>;
      confirmMemory: (input: {
        memoryId: string;
        revision: number;
        expectedRevision: number;
      }) => Promise<MemoryListView>;
      correctMemory: (input: {
        memoryId: string;
        text: string;
        expectedRevision: number;
      }) => Promise<MemoryListView>;
      discardMemory: (input: {
        memoryId: string;
        expectedRevision: number;
      }) => Promise<MemoryListView>;
      revokeMemory: (input: {
        memoryId: string;
        expectedRevision: number;
      }) => Promise<MemoryListView & { notice: string }>;
      forgetMemory: (
        memoryId: string,
      ) => Promise<MemoryListView & { notice: string }>;
    };
  }
  type IdeaPurpose = "portfolio" | "practical" | "both";
  type IdeaModelConfig = {
    provider: "openai";
    model: string;
    contextTokens: number | null;
  };
  type IdeaHistoryItem = {
    operationId: string;
    title: string;
    modality: "new" | "improvement" | null;
    purpose: IdeaPurpose;
    createdAt: string;
    articleTitle: string;
    contentId: string | null;
    rating: number | null;
    contextRevoked: boolean;
    pendingTermsCount: number;
  };
  type IgnoredSourceView = {
    id: string;
    kind: "file" | "memory";
    relativePath: string | null;
    memoryId: string | null;
    label: string;
    createdAt: string;
  };
  type IdeaOutcome =
    | "recommendation"
    | "insufficient_context"
    | "no_application"
    | "failed"
    | "canceled"
    | "interrupted";
  type IdeaEvent =
    | {
        type: "state";
        operationId: string;
        contentId: string | null;
        state: string;
        contextMode: "full" | "article_only";
      }
    | {
        type: "finished";
        operationId: string;
        contentId: string | null;
        contextMode: "full" | "article_only";
        comparisonOf: string | null;
        articleTitle: string;
        outcome: IdeaOutcome;
        title: string;
        error: string | null;
      };
  type PackageItemView = {
    id: string;
    kind: "article" | "evidence" | "memory";
    label: string;
    text: string;
    projectLabel: string | null;
    relativePath: string | null;
    lines: string | null;
    memoryKind: MemoryKindName | null;
  };
  type IdeaView = {
    busy: boolean;
    evaluation: { id: string; decided: boolean } | null;
    operation: {
      id: string;
      contentId: string | null;
      state: string;
      error: string | null;
      purpose: IdeaPurpose;
      contextMode: "full" | "article_only";
      comparisonOf: string | null;
      projectsConsulted: boolean;
      selectedProjectIds: string[] | null;
      article: {
        title: string;
        coverage: string;
        limitations: string[];
        characters: number;
        capturedAt: string;
      } | null;
    };
    package: {
      id: string;
      reviewToken: string;
      payloadSha256: string;
      provider: string;
      model: string;
      purpose: IdeaPurpose;
      estimatedTokens: number;
      callBudget: number;
      notices: string[];
      projectsConsulted: boolean;
      items: PackageItemView[];
    } | null;
    recommendation: {
      status: string;
      modality: "new" | "improvement" | null;
      targetProjectId: string | null;
      title: string;
      summary: string;
      description: string;
      firstVersion: string;
      terms: IdeaTermView[];
      effort: { estimate: string; assumptions: string[] } | null;
      reasons: Array<{
        text: string;
        evidenceIds: string[];
        inferred: boolean;
      }>;
      stack: Array<{ name: string; justification: string }>;
      limitations: string[];
      model: string;
      createdAt: string;
      rating: {
        score: number;
        comment: string;
        clearLanguage?: boolean;
      } | null;
      contextRevoked: boolean;
      citedEvidence: Array<{ id: string; label: string; excerpt: string }>;
    } | null;
    modelConfig: IdeaModelConfig;
  };
  type ComparisonVersion = {
    status: string;
    modality: "new" | "improvement" | null;
    title: string;
    description: string;
    firstVersion: string;
    reasons: Array<{ text: string; inferred: boolean }>;
    stack: Array<{ name: string; justification: string }>;
    limitations: string[];
  };
  type ComparisonView = {
    evaluationId: string;
    ready: boolean;
    a: ComparisonVersion | null;
    b: ComparisonVersion | null;
    preference: "A" | "B" | "tie" | null;
    reveal: { a: string; b: string } | null;
  };
  type CatalogCoverageView = {
    cataloged: number;
    consulted: number;
    excluded: number;
    pending: number;
    secretBlockedChunks: number;
    skippedDirectories: number;
    partial: boolean;
    graphStatus: Record<string, string>;
  };
  type ProjectContextStatus = {
    isolation: {
      state: "ready" | "unavailable" | "blocked" | "disabled";
      reasons: string[];
    };
    policySha256: string;
    projects: Array<{
      id: string;
      label: string;
      status: string;
      updatedAt: string;
    }>;
    lastCatalog: { at: string; coverage: CatalogCoverageView } | null;
  };
  type MemoryKindName =
    | "goal"
    | "preference"
    | "experience"
    | "constraint"
    | "project_context"
    | "knowledge";
  type IdeaTermView = {
    name: string;
    explanation: string;
    knowledge: { memoryId: string; known: boolean; text: string } | null;
  };
  type MemoryRevisionView = {
    memoryId: string;
    revision: number;
    kind: MemoryKindName;
    text: string;
    origin: string;
    state: string;
    proposedAt: string;
    approvedAt: string | null;
  };
  type MemoryListView = {
    globalRevision: number;
    kinds: MemoryKindName[];
    memories: Array<{
      memoryId: string;
      latestRevision: number;
      confirmed: MemoryRevisionView | null;
      conflicted: MemoryRevisionView | null;
      pending: MemoryRevisionView | null;
      revoked: boolean;
      ignoredInIdeas: boolean;
    }>;
  };
  type UserProfile = {
    topics: { name: string; importance: number }[];
    mediumFeeds: string[];
    recencyPreference: number;
  };
  type InterestProfileV2 = {
    schemaVersion: 2;
    status: "draft" | "confirmed";
    intentText: string;
    interestGroups: Array<{
      id: string;
      label: string;
      summary: string;
      priority: number;
      objectives: string[];
      subtopics: string[];
      retrievalTerms: { devtoTags: string[]; mediumTopics: string[] };
    }>;
    positiveTraits: string[];
    deprioritizeTraits: string[];
    examples: Array<{
      polarity: "positive" | "negative";
      url?: string;
      title: string;
      excerpt: string;
    }>;
    mediumFeeds: string[];
    recencyPreference: number;
    revision: number;
  };
  type ProfileProposalInput = {
    intentText: string;
    positiveExamples: string[];
    negativeExamples: string[];
  };
  type DiscoveryStats = {
    devtoFetched: number;
    mediumFetched: number;
    uniqueFetched: number;
    duplicatesRemoved: number;
    added: number;
    stored: number;
    assessed: number;
    awaitingAssessment: number;
    withoutTopicMatch: number;
    jevZeroUtility: number;
    jevZeroSamples: Array<{ title: string; url: string }>;
    exploratory: number;
    ranked: number;
    beyondFirstPage: number;
    errors: number;
  };
  type BackupCounts = {
    articles: number;
    feedback: number;
    mediumSignals: number;
    ideas: number;
    capturedArticles: number;
    evaluations: number;
    ignoredSources: number;
    memories: number;
    forgottenMemories: number;
    projectContextIncluded: boolean;
  };
  type MediumArchivePreview = {
    total: number;
    bookmarks: number;
    claps: number;
    listItems: number;
    uniqueArticles: number;
    samples: Array<{
      title: string;
      signals: Array<"bookmark" | "clap" | "list">;
    }>;
  };
  type AppState = {
    profile: UserProfile | InterestProfileV2;
    draftProfile: InterestProfileV2 | null;
    items: ContentItem[];
    discoveryStats: DiscoveryStats | null;
    hasApiKey: boolean;
    hasJevKey: boolean;
    lastRefresh: string | null;
    rankingSource: "jev" | "fallback" | "reference";
    rankingStatus: string;
  };
  type ContentItem = {
    id: string;
    source: "devto" | "medium";
    title: string;
    url: string;
    author: string;
    publishedAt: string;
    description: string;
    tags: string[];
    readingMinutes: number | null;
    summary: string | null;
    category: string | null;
    hypeEvidence: string[];
    hypeConfidence: number | null;
    personalUtility?: number | null;
    technicalSubstance?: number | null;
    topicFit?: number | null;
    assessmentConfidence?: number | null;
    score: number;
    reasons: string[];
    saved: boolean;
    rating: string | null;
    hidden: boolean;
    isExploratory: boolean;
    jevAssessment?: {
      provider: "typesafe";
      model: string;
      rubricVersion: string;
      profileRevision: number;
      contentFingerprint: string;
      assessedAt: string;
      status: "valid" | "partial";
      utility?: {
        level: string;
        score: number;
        confidence: number;
        probabilities: Record<string, number>;
        legend: string[];
      };
      technicalDepth?: {
        level: string;
        score: number;
        confidence: number;
        probabilities: Record<string, number>;
        legend: string[];
      };
    } | null;
  };
}
