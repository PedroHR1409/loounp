import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  settings: new Map<string, string>(),
  content: [] as Array<{ data: string }>,
  feedback: [] as Array<{
    content_id: string;
    action: string;
    value: string | null;
    created_at: string;
  }>,
}));

vi.mock("electron", () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    getPath: () => "C:/temp/radar-test",
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    webContents = { setWindowOpenHandler: vi.fn() };
    loadURL = vi.fn();
    loadFile = vi.fn();
  },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) =>
      memory.handlers.set(name, handler),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock("./database", () => ({
  all: (sql: string) =>
    sql.includes("FROM content")
      ? memory.content
      : sql.includes("FROM feedback")
        ? memory.feedback
        : [],
  getSetting: (key: string) => memory.settings.get(key) ?? null,
  openDatabase: vi.fn(),
  persist: vi.fn(async () => undefined),
  run: vi.fn(),
  setSetting: (key: string, value: string) => memory.settings.set(key, value),
}));

vi.mock("./sources", () => ({
  fetchDevto: vi.fn(async () => []),
  fetchMedium: vi.fn(async () => []),
  deduplicateByCanonicalUrl: (items: unknown[]) => items,
}));
vi.mock("./discovery", () => ({
  assessContentBatch: vi.fn(async () => []),
  proposeInterestProfile: vi.fn(),
}));

await import("./index");

const emptyDraft = {
  schemaVersion: 2 as const,
  status: "draft" as const,
  intentText: "Quero encontrar projetos de IA úteis",
  interestGroups: [
    {
      id: "ai-projects",
      label: "Projetos de IA",
      summary: "Projetos práticos de IA",
      priority: 5,
      objectives: ["construir projetos de IA"],
      subtopics: ["agentes de IA"],
      retrievalTerms: { devtoTags: ["ai"], mediumTopics: ["ai-agents"] },
    },
  ],
  positiveTraits: ["exemplos de implementação"],
  deprioritizeTraits: ["promoção sem detalhes"],
  examples: [],
  mediumFeeds: ["https://medium.com/feed/tag/ai-agents"],
  recencyPreference: 0.5,
  revision: 1,
};

describe("profile IPC integration", () => {
  beforeEach(() => {
    memory.settings.clear();
    memory.content.length = 0;
    memory.feedback.length = 0;
  });

  it("persists only a validated, explicitly confirmed profile and returns it as active", async () => {
    await memory.handlers.get("profile:confirm")!({}, emptyDraft);

    const active = JSON.parse(memory.settings.get("profile_v2")!);
    expect(active.status).toBe("confirmed");
    expect(active.interestGroups[0].label).toBe("Projetos de IA");
    expect(memory.settings.get("profile_v2_draft")).toBe("");

    const state = await memory.handlers.get("app:get-state")!({});
    expect(state.profile.schemaVersion).toBe(2);
    expect(state.profile.status).toBe("confirmed");
    expect(state.draftProfile).toBeNull();
  });

  it("rejects an empty interest map without replacing the current profile", async () => {
    memory.settings.set(
      "profile_v2",
      JSON.stringify({ ...emptyDraft, status: "confirmed" }),
    );
    await expect(
      memory.handlers.get("profile:confirm")!(
        {},
        { ...emptyDraft, interestGroups: [] },
      ),
    ).rejects.toThrow("pelo menos um tema");
    expect(
      JSON.parse(memory.settings.get("profile_v2")!).interestGroups,
    ).toHaveLength(1);
  });

  it("exposes the persisted reference fallback mode in the renderer state", async () => {
    memory.settings.set("ranking_status", "fallback");
    memory.settings.set("ranking_mode", "reference");
    const state = await memory.handlers.get("app:get-state")!({});
    expect(state.rankingSource).toBe("fallback");
    expect(state.rankingStatus).toBe("fallback");
    expect(state.items).toEqual([]);
  });

  it("registers only the specific article-to-project channels and keeps the existing feed channels", () => {
    const feature = [...memory.handlers.keys()]
      .filter((name) =>
        /^(project-ideas|project-context|personal-memory):/.test(name),
      )
      .sort();
    expect(feature).toEqual([
      "personal-memory:answer-knowledge",
      "personal-memory:confirm",
      "personal-memory:correct",
      "personal-memory:discard",
      "personal-memory:forget",
      "personal-memory:list",
      "personal-memory:propose",
      "personal-memory:revoke",
      "personal-memory:set-ignored",
      "project-context:ignored",
      "project-context:read-evidence",
      "project-context:refresh",
      "project-context:remove",
      "project-context:set-real-sources",
      "project-context:status",
      "project-context:unignore",
      "project-ideas:authorize",
      "project-ideas:cancel",
      "project-ideas:compare-record",
      "project-ideas:compare-start",
      "project-ideas:comparison",
      "project-ideas:delete",
      "project-ideas:deny",
      "project-ideas:get-status",
      "project-ideas:history",
      "project-ideas:rate",
      "project-ideas:rebuild",
      "project-ideas:remove-item",
      "project-ideas:set-model",
      "project-ideas:set-purpose",
      "project-ideas:start",
      "project-ideas:submit-text",
      "project-ideas:view",
    ]);
    for (const channel of [
      "app:get-state",
      "feed:refresh",
      "feedback:record",
      "profile:confirm",
      "content:analyze",
    ])
      expect(memory.handlers.has(channel)).toBe(true);
  });

  it("rejects feature calls from senders other than the main window frame", async () => {
    await expect(
      memory.handlers.get("project-ideas:start")!(
        { sender: {}, senderFrame: {} },
        { url: "https://example.com", purpose: "both" },
      ),
    ).rejects.toThrow("não autorizada");
    await expect(
      memory.handlers.get("personal-memory:list")!({}),
    ).rejects.toThrow("não autorizada");
  });

  it("returns a discovery funnel snapshot after a refresh, including an empty source response", async () => {
    const result = await memory.handlers.get("feed:refresh")!({});

    expect(result.stats).toMatchObject({
      devtoFetched: 0,
      mediumFetched: 0,
      uniqueFetched: 0,
      duplicatesRemoved: 0,
      added: 0,
      ranked: 0,
      beyondFirstPage: 0,
      errors: 0,
    });
    expect(JSON.parse(memory.settings.get("discovery_stats")!)).toEqual(
      result.stats,
    );
  });
});
