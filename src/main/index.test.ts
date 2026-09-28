import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC mock: each channel has its own handler signature
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC mock: each channel has its own handler signature
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

vi.mock("./storage/database", () => ({
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

vi.mock("./discovery/sources", () => ({
  fetchDevto: vi.fn(async () => []),
  fetchMedium: vi.fn(async () => []),
  deduplicateByCanonicalUrl: (items: unknown[]) => items,
}));
vi.mock("./discovery/content-discovery", () => ({
  assessContentBatch: vi.fn(async () => []),
  proposeInterestProfile: vi.fn(),
}));

vi.mock("./security/ipc-security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security/ipc-security")>();
  return {
    ...actual,
    assertTrustedIpcSender: (
      event: Parameters<typeof actual.assertTrustedIpcSender>[0],
      mainWindow: Parameters<typeof actual.assertTrustedIpcSender>[1],
      isTrustedRendererUrl: Parameters<typeof actual.assertTrustedIpcSender>[2],
    ) => {
      // Existing handler integration cases use {} as a placeholder event.
      // Real Electron IPC events always include sender and senderFrame.
      if (!("sender" in event) && !("senderFrame" in event)) return;
      actual.assertTrustedIpcSender(event, mainWindow, isTrustedRendererUrl);
    },
  };
});

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

  it("saves a legacy profile with a non-Medium HTTPS feed and rejects a private-host feed", async () => {
    await memory.handlers.get("profile:save")!(
      {},
      {
        topics: [{ name: "AI", importance: 3 }],
        mediumFeeds: ["https://example.com/feed.xml"],
        recencyPreference: 0.5,
      },
    );
    expect(JSON.parse(memory.settings.get("profile")!).mediumFeeds).toEqual([
      "https://example.com/feed.xml",
    ]);

    await expect(
      memory.handlers.get("profile:save")!(
        {},
        {
          topics: [{ name: "AI", importance: 3 }],
          mediumFeeds: ["https://127.0.0.1/feed.xml"],
          recencyPreference: 0.5,
        },
      ),
    ).rejects.toThrow("rede privada/local");
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
      "project-context:set-semantic-rerank",
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
      "settings:set-discovery-interval",
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
      memory.handlers.get("personal-memory:list")!(
        { sender: {}, senderFrame: {} },
      ),
    ).rejects.toThrow("não autorizada");

    const security = await vi.importActual<typeof import("./security/ipc-security")>(
      "./security/ipc-security",
    );
    const mainFrame = { url: "file:///trusted/index.html" };
    const webContents = { mainFrame };
    const trustedWindow = { webContents };
    expect(() =>
      security.assertTrustedIpcSender(
        { sender: webContents, senderFrame: mainFrame },
        trustedWindow,
        (url) => url === "file:///trusted/index.html",
      ),
    ).not.toThrow();
    expect(() =>
      security.assertTrustedIpcSender(
        { sender: webContents, senderFrame: mainFrame },
        trustedWindow,
        () => false,
      ),
    ).toThrow("não autorizada");
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

  it("prevents an overlapping feed refresh from running concurrently", async () => {
    const refresh = memory.handlers.get("feed:refresh")!;
    const first = refresh({});
    await expect(refresh({})).rejects.toThrow("já está em andamento");
    await first;
  });

  it("validates and persists the discovery interval preference", async () => {
    const setInterval = memory.handlers.get(
      "settings:set-discovery-interval",
    )!;
    await expect(setInterval({}, 5)).rejects.toThrow(
      "Intervalo de busca automática inválido.",
    );
    expect(memory.settings.has("discovery_interval_hours")).toBe(false);

    await setInterval({}, 12);
    expect(memory.settings.get("discovery_interval_hours")).toBe("12");
  });

  it("exposes the discovery interval preference in app state, defaulting to off", async () => {
    const state = await memory.handlers.get("app:get-state")!({});
    expect(state.discoveryIntervalHours).toBe(0);

    memory.settings.set("discovery_interval_hours", "24");
    const updated = await memory.handlers.get("app:get-state")!({});
    expect(updated.discoveryIntervalHours).toBe(24);
  });
});
