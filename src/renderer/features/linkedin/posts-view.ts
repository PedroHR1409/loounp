type SourceMode = LinkedInPostSource["kind"];

const root = () => document.querySelector<HTMLElement>("#linkedin-posts-view")!;
let initialized = false;
let working = false;
let records: LinkedInPostRecord[] = [];
let selected: LinkedInPostRecord | null = null;
let feedItems: ContentItem[] = [];
let savedIdeas: IdeaHistoryItem[] = [];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function setMessage(text: string, kind: "error" | "success" | "info" = "info") {
  const message = document.querySelector<HTMLElement>("#linkedin-message");
  if (!message) return;
  message.hidden = !text;
  message.className = `notice notice-${kind === "error" ? "err" : kind === "success" ? "ok" : "info"}`;
  message.textContent = text;
}

function initialize() {
  if (initialized) return;
  initialized = true;
  root().innerHTML = `
    <header class="page-head">
      <div class="eyebrow">ESCRITA PARA LINKEDIN</div>
      <div class="page-head-row"><div><h1>Transforme uma ideia em post</h1><p>Foco editorial em alcance qualificado, conversa relevante e conteúdo que valha salvar.</p></div></div>
    </header>
    <div class="linkedin-scroll">
      <div class="linkedin-layout">
        <div class="linkedin-compose-column">
          <form id="linkedin-post-form" class="linkedin-card">
            <div class="linkedin-card-title"><h2>De onde partimos?</h2><span class="chip">IA · Engenharia de Dados</span></div>
            <label for="linkedin-source-mode">Fonte</label>
            <select id="linkedin-source-mode" class="field">
              <option value="article_url">Artigo por URL</option>
              <option value="feed_article">Artigo do feed</option>
              <option value="article_text">Texto de artigo colado</option>
              <option value="idea_text">Ideia escrita aqui</option>
              <option value="saved_idea">Ideia salva no Loounp</option>
            </select>
            <div id="linkedin-url-fields" class="linkedin-source-fields">
              <label for="linkedin-source-url">Link público do artigo</label>
              <input id="linkedin-source-url" class="field" type="url" placeholder="https://exemplo.com/artigo" />
              <label for="linkedin-url-title">Título (opcional)</label>
              <input id="linkedin-url-title" class="field" type="text" maxlength="240" placeholder="Título do artigo" />
            </div>
            <div id="linkedin-feed-fields" class="linkedin-source-fields" hidden>
              <label for="linkedin-feed-article">Artigo do feed</label>
              <select id="linkedin-feed-article" class="field"></select>
            </div>
            <div id="linkedin-article-text-fields" class="linkedin-source-fields" hidden>
              <label for="linkedin-article-title">Título (opcional)</label>
              <input id="linkedin-article-title" class="field" type="text" maxlength="240" placeholder="Título do artigo" />
              <label for="linkedin-article-text">Texto do artigo</label>
              <textarea id="linkedin-article-text" rows="7" maxlength="18000" placeholder="Cole o artigo ou o trecho que quer transformar"></textarea>
            </div>
            <div id="linkedin-idea-fields" class="linkedin-source-fields" hidden>
              <label for="linkedin-idea-text">Sua ideia</label>
              <textarea id="linkedin-idea-text" rows="6" maxlength="18000" placeholder="Qual ponto você quer compartilhar? Inclua contexto e sua opinião se quiser."></textarea>
            </div>
            <div id="linkedin-saved-idea-fields" class="linkedin-source-fields" hidden>
              <label for="linkedin-saved-idea">Ideia salva</label>
              <select id="linkedin-saved-idea" class="field"></select>
            </div>
            <div id="linkedin-message" class="notice" role="status" hidden></div>
            <p class="linkedin-note">A IA vai usar a fonte como base, sem inventar experiência pessoal ou copiar o texto. A geração usa a chave OpenAI já configurada no Loounp.</p>
            <button id="linkedin-generate" class="cta" type="submit">Gerar post e horário sugerido</button>
          </form>
          <section id="linkedin-output" class="linkedin-card linkedin-output" hidden></section>
        </div>
        <aside class="linkedin-card linkedin-history-card">
          <div class="linkedin-card-title"><div><h2>Rascunhos</h2><p>Salvos neste computador</p></div><button id="linkedin-refresh-history" class="text-btn" type="button">Atualizar</button></div>
          <div id="linkedin-history" class="linkedin-history"></div>
        </aside>
      </div>
    </div>`;

  document
    .querySelector<HTMLSelectElement>("#linkedin-source-mode")!
    .addEventListener("change", renderSourceFields);
  document
    .querySelector<HTMLFormElement>("#linkedin-post-form")!
    .addEventListener("submit", (event) => void generate(event));
  document
    .querySelector<HTMLButtonElement>("#linkedin-refresh-history")!
    .addEventListener("click", () => void loadHistory());
}

function renderSourceFields() {
  const mode = document.querySelector<HTMLSelectElement>("#linkedin-source-mode")!.value as SourceMode;
  const fields: Partial<Record<SourceMode, string>> = {
    article_url: "linkedin-url-fields",
    feed_article: "linkedin-feed-fields",
    article_text: "linkedin-article-text-fields",
    idea_text: "linkedin-idea-fields",
    saved_idea: "linkedin-saved-idea-fields",
  };
  for (const id of Object.values(fields))
    document.getElementById(id!)!.hidden = true;
  const id = fields[mode];
  if (id) document.getElementById(id)!.hidden = false;
}

function fillSelect(select: HTMLSelectElement, placeholder: string, values: Array<{ value: string; label: string }>) {
  select.replaceChildren(new Option(placeholder, ""));
  for (const item of values) select.add(new Option(item.label, item.value));
}

function loadSourceOptions() {
  fillSelect(
    document.querySelector<HTMLSelectElement>("#linkedin-feed-article")!,
    feedItems.length ? "Selecione um artigo" : "O feed ainda não tem artigos",
    feedItems.map((item) => ({ value: item.id, label: item.title.slice(0, 150) })),
  );
  fillSelect(
    document.querySelector<HTMLSelectElement>("#linkedin-saved-idea")!,
    savedIdeas.length ? "Selecione uma ideia" : "Nenhuma ideia salva encontrada",
    savedIdeas.map((item) => ({ value: item.operationId, label: `${item.title} · ${item.articleTitle}`.slice(0, 180) })),
  );
}

function selectSource(source: LinkedInPostSource) {
  const mode = document.querySelector<HTMLSelectElement>("#linkedin-source-mode")!;
  mode.value = source.kind;
  renderSourceFields();

  if (source.kind === "article_url") {
    document.querySelector<HTMLInputElement>("#linkedin-source-url")!.value = source.url;
    document.querySelector<HTMLInputElement>("#linkedin-url-title")!.value = source.title ?? "";
  } else if (source.kind === "feed_article") {
    const select = document.querySelector<HTMLSelectElement>("#linkedin-feed-article")!;
    if (![...select.options].some((option) => option.value === source.contentId))
      select.add(new Option("Artigo selecionado", source.contentId));
    select.value = source.contentId;
  } else if (source.kind === "article_text") {
    document.querySelector<HTMLInputElement>("#linkedin-article-title")!.value = source.title ?? "";
    document.querySelector<HTMLTextAreaElement>("#linkedin-article-text")!.value = source.text;
  } else if (source.kind === "idea_text") {
    document.querySelector<HTMLTextAreaElement>("#linkedin-idea-text")!.value = source.text;
  } else {
    const select = document.querySelector<HTMLSelectElement>("#linkedin-saved-idea")!;
    if (![...select.options].some((option) => option.value === source.operationId))
      select.add(new Option("Ideia selecionada", source.operationId));
    select.value = source.operationId;
  }
}

function getSource(): LinkedInPostSource {
  const mode = document.querySelector<HTMLSelectElement>("#linkedin-source-mode")!.value as SourceMode;
  if (mode === "article_url")
    return {
      kind: mode,
      url: document.querySelector<HTMLInputElement>("#linkedin-source-url")!.value.trim(),
      title: document.querySelector<HTMLInputElement>("#linkedin-url-title")!.value.trim(),
    };
  if (mode === "feed_article")
    return { kind: mode, contentId: document.querySelector<HTMLSelectElement>("#linkedin-feed-article")!.value };
  if (mode === "article_text")
    return {
      kind: mode,
      title: document.querySelector<HTMLInputElement>("#linkedin-article-title")!.value.trim(),
      text: document.querySelector<HTMLTextAreaElement>("#linkedin-article-text")!.value,
    };
  if (mode === "idea_text")
    return { kind: mode, text: document.querySelector<HTMLTextAreaElement>("#linkedin-idea-text")!.value };
  return { kind: "saved_idea", operationId: document.querySelector<HTMLSelectElement>("#linkedin-saved-idea")!.value };
}

async function generateFromSource(source: LinkedInPostSource) {
  if (working) return;
  const button = document.querySelector<HTMLButtonElement>("#linkedin-generate")!;
  working = true;
  button.disabled = true;
  button.textContent = "Escrevendo…";
  selected = null;
  renderOutput();
  setMessage("Lendo a fonte e preparando o rascunho…");
  try {
    selected = await window.linkedinPosts.generate({ source });
    records = await window.linkedinPosts.list();
    renderHistory();
    renderOutput();
    setMessage("Rascunho criado. Revise os fatos e ajuste a sua voz antes de publicar.", "success");
  } catch (error) {
    setMessage(String((error as Error)?.message ?? error), "error");
  } finally {
    working = false;
    button.disabled = false;
    button.textContent = "Gerar post e horário sugerido";
  }
}

async function generate(event: SubmitEvent) {
  event.preventDefault();
  await generateFromSource(getSource());
}

function chooseHook(hook: string) {
  if (!selected) return;
  const textarea = document.querySelector<HTMLTextAreaElement>("#linkedin-post-text")!;
  const existing = textarea.value;
  const body = existing.startsWith(selected.selectedHook)
    ? existing.slice(selected.selectedHook.length).replace(/^\s*\n?/, "")
    : existing;
  textarea.value = body ? `${hook}\n\n${body}` : hook;
  selected = { ...selected, selectedHook: hook, post: textarea.value };
  renderOutput();
}

function renderOutput() {
  const output = document.querySelector<HTMLElement>("#linkedin-output")!;
  output.replaceChildren();
  output.hidden = !selected;
  if (!selected) return;

  const current = selected;
  const top = node("div", "linkedin-output-head");
  top.append(node("div", "eyebrow", "RASCUNHO · FOCO EM ALCANCE QUALIFICADO"));
  top.append(node("h2", "", current.sourceTitle));
  const schedule = node("div", "linkedin-schedule");
  schedule.append(node("span", "linkedin-schedule-label", "Horário recomendado"));
  schedule.append(node("strong", "", current.recommendedAt.label));
  schedule.append(node("p", "", current.recommendedAt.rationale));
  const hookHeading = node("h3", "linkedin-section-heading", "Escolha um gancho");
  const hooks = node("div", "linkedin-hooks");
  current.hooks.forEach((hook, index) => {
    const button = node("button", "linkedin-hook", `${index + 1}. ${hook}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(current.selectedHook === hook));
    button.addEventListener("click", () => chooseHook(hook));
    hooks.append(button);
  });
  const label = node("label", "", "Revise o texto");
  label.htmlFor = "linkedin-post-text";
  const text = node("textarea", "linkedin-post-textarea");
  text.id = "linkedin-post-text";
  text.value = current.post;
  text.maxLength = 5000;
  text.addEventListener("input", () => {
    if (selected) selected = { ...selected, post: text.value };
  });
  const angle = node("p", "linkedin-note", `Ângulo: ${current.angle || "ideia central da fonte"}`);
  const rationale = node("p", "linkedin-note", current.engagementRationale);
  const actions = node("div", "linkedin-actions");
  const save = node("button", "btn", "Salvar alterações");
  save.type = "button";
  save.addEventListener("click", () => void saveCurrent());
  const copy = node("button", "cta", "Copiar texto");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.querySelector<HTMLTextAreaElement>("#linkedin-post-text")!.value);
      setMessage("Post copiado para a área de transferência.", "success");
    } catch {
      setMessage("Não foi possível acessar a área de transferência. Selecione o texto e copie manualmente.", "error");
    }
  });
  actions.append(save, copy);
  output.append(top, schedule, hookHeading, hooks, label, text, angle, rationale, actions);
}

async function saveCurrent() {
  if (!selected) return;
  try {
    const post = document.querySelector<HTMLTextAreaElement>("#linkedin-post-text")!.value;
    records = await window.linkedinPosts.update({ id: selected.id, post, selectedHook: selected.selectedHook });
    selected = records.find((record) => record.id === selected!.id) ?? selected;
    renderHistory();
    setMessage("Alterações salvas neste computador.", "success");
  } catch (error) {
    setMessage(String((error as Error)?.message ?? error), "error");
  }
}

function renderHistory() {
  const list = document.querySelector<HTMLElement>("#linkedin-history");
  if (!list) return;
  list.replaceChildren();
  if (!records.length) {
    list.append(node("p", "linkedin-empty", "Seus rascunhos gerados aparecerão aqui."));
    return;
  }
  for (const record of records) {
    const card = node("div", `linkedin-history-item ${selected?.id === record.id ? "selected" : ""}`);
    const open = node("button", "linkedin-history-open");
    open.type = "button";
    open.append(node("strong", "", record.sourceTitle));
    open.append(node("span", "", `${record.sourceKind === "article" ? "Artigo" : "Ideia"} · ${new Date(record.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`));
    open.addEventListener("click", () => {
      selected = record;
      renderHistory();
      renderOutput();
    });
    const remove = node("button", "linkedin-history-delete", "Excluir");
    remove.type = "button";
    remove.setAttribute("aria-label", `Excluir rascunho ${record.sourceTitle}`);
    remove.addEventListener("click", () => void deleteRecord(record.id));
    card.append(open, remove);
    list.append(card);
  }
}

async function deleteRecord(id: string) {
  try {
    records = await window.linkedinPosts.delete(id);
    if (selected?.id === id) selected = records[0] ?? null;
    renderHistory();
    renderOutput();
  } catch (error) {
    setMessage(String((error as Error)?.message ?? error), "error");
  }
}

async function loadHistory() {
  try {
    [records, feedItems, savedIdeas] = await Promise.all([
      window.linkedinPosts.list(),
      window.contentApp.getState().then((state) => state.items.filter((item) => !item.hidden).slice(0, 100)),
      window.projectIdeas.history().catch(() => [] as IdeaHistoryItem[]),
    ]);
    if (!selected || !records.some((record) => record.id === selected!.id))
      selected = records[0] ?? null;
    loadSourceOptions();
    renderHistory();
    renderOutput();
  } catch (error) {
    setMessage(String((error as Error)?.message ?? error), "error");
  }
}

export async function showLinkedInPostsView(source?: LinkedInPostSource) {
  root().hidden = false;
  initialize();
  await loadHistory();
  if (source) {
    selectSource(source);
    selected = null;
    renderHistory();
    renderOutput();
  }
  const hasApiKey = await window.contentApp.getState().then((state) => state.hasApiKey).catch(() => false);
  if (source && hasApiKey) await generateFromSource(source);
  else if (!hasApiKey)
    setMessage("Adicione uma chave OpenAI em Configurações para gerar um post. Seus rascunhos salvos continuam disponíveis.", "info");
}

export function hideLinkedInPostsView() {
  root().hidden = true;
}
