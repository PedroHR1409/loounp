import type { ThemeBriefing, ThemeSearchEvent, ThemeSearchInput } from "../../../core/theme-research/contracts";
import { refreshIdeasView } from "../ideas/ideas-view";

const dialog = document.querySelector<HTMLDialogElement>("#theme-research-dialog")!;
const content = document.querySelector<HTMLElement>("#theme-research-content")!;
let activeSearchId: string | null = null;
let pendingEvents: ThemeSearchEvent[] = [];

export function setupThemeResearch() {
  window.themeResearch.onEvent(handleSearchEvent);
  document.querySelector<HTMLButtonElement>("#close-theme-research")?.addEventListener("click", () => dialog.close());
  document.querySelector<HTMLButtonElement>("#search-theme")?.addEventListener("click", () => {
    void openSearch();
  });
  dialog.addEventListener("close", () => {
    if (activeSearchId) void window.themeResearch.cancel(activeSearchId).catch(() => undefined);
    activeSearchId = null;
  });
}

async function openSearch() {
  const status = await window.projectIdeas.contextStatus().catch(() => null);
  content.innerHTML = `<div class="eyebrow">DESCOBERTA</div><h2>Pesquisar um tema</h2><p>Busque artigos nas fontes configuradas e no catálogo local. A consulta e os trechos selecionados serão enviados à OpenAI para criar o briefing.</p><form id="theme-search-form" class="theme-search-form"><label>Tema ou ferramenta<input id="theme-query" name="query" minlength="2" maxlength="120" required placeholder="Ex.: Jev" autofocus></label><label>Projeto (opcional)<select id="theme-project"><option value="">Sem projeto</option>${(status?.projects ?? []).map((project) => `<option value="${escapeAttr(project.id)}">${escapeHtml(project.label)}</option>`).join("")}</select></label><p class="theme-hint">Selecionar um projeto apenas associa as ideias salvas; não envia arquivos do projeto.</p><button class="btn" type="submit">Pesquisar</button></form><div id="theme-search-result" aria-live="polite"></div>`;
  dialog.showModal();
  content.querySelector<HTMLFormElement>("#theme-search-form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitButton = (event.currentTarget as HTMLFormElement).querySelector<HTMLButtonElement>('button[type="submit"]')!;
    if (submitButton.disabled) return;
    const query = content.querySelector<HTMLInputElement>("#theme-query")!.value;
    const projectId = content.querySelector<HTMLSelectElement>("#theme-project")!.value;
    submitButton.disabled = true;
    void search({ query, mode: projectId ? "associate" : "none", ...(projectId ? { projectId } : {}) }).finally(() => {
      submitButton.disabled = false;
    });
  });
}

async function search(input: ThemeSearchInput) {
  const result = content.querySelector<HTMLElement>("#theme-search-result")!;
  activeSearchId = null;
  pendingEvents = [];
  result.innerHTML = `<p id="theme-search-progress" class="theme-loading" aria-live="polite">Iniciando pesquisa…</p>`;
  try {
    const { searchId } = await window.themeResearch.start(input);
    activeSearchId = searchId;
    result.innerHTML = `<p id="theme-search-progress" class="theme-loading" aria-live="polite">Buscando artigos…</p><button id="cancel-theme-search" type="button" class="btn btn-secondary">Cancelar pesquisa</button>`;
    result.querySelector<HTMLButtonElement>("#cancel-theme-search")?.addEventListener("click", () => {
      void window.themeResearch.cancel(searchId);
    });
    const queued = pendingEvents.filter((event) => event.searchId === searchId);
    pendingEvents = [];
    queued.forEach(handleSearchEvent);
  } catch (error) {
    result.innerHTML = `<p class="theme-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function handleSearchEvent(event: ThemeSearchEvent) {
  if (event.searchId !== activeSearchId) {
    pendingEvents.push(event);
    if (pendingEvents.length > 20) pendingEvents = pendingEvents.slice(-20);
    return;
  }
  const root = content.querySelector<HTMLElement>("#theme-search-result");
  if (!root) return;
  if (event.type === "result") {
    activeSearchId = null;
    renderBriefing(root, event.briefing);
    return;
  }
  if (event.type === "error") {
    activeSearchId = null;
    root.innerHTML = `<p class="theme-error">${escapeHtml(event.message)}</p>`;
    return;
  }
  if (event.type === "progress") {
    const progress = root.querySelector<HTMLElement>("#theme-search-progress");
    if (progress) progress.textContent = event.message;
    return;
  }
  const progress = root.querySelector<HTMLElement>("#theme-search-progress");
  if (!progress) return;
  if (event.status === "synthesizing")
    progress.textContent = "Preparando o briefing…";
  else if (event.status === "canceled") {
    activeSearchId = null;
    root.innerHTML = `<p class="theme-hint">Pesquisa cancelada.</p>`;
  } else if (event.message) progress.textContent = event.message;
}

function renderBriefing(root: HTMLElement, briefing: ThemeBriefing) {
  if (briefing.status === "empty" || briefing.status === "failed") {
    root.innerHTML = `<p class="theme-empty">${briefing.status === "failed" ? "As fontes não responderam. Tente novamente." : "Nenhum artigo relevante foi encontrado para este tema."}</p>${sourceNotes(briefing)}`;
    return;
  }
  root.innerHTML = `${briefing.status === "partial" ? `<p class="theme-hint">Busca parcial. ${sourceNotes(briefing)}</p>` : ""}<div class="theme-groups">${briefing.groups.map((group) => `<section class="theme-group"><div class="eyebrow">SUBTEMA</div><h3>${escapeHtml(group.label)}</h3><p>${escapeHtml(group.summary)}</p><div class="theme-articles">${group.articleIds.map((id) => briefing.articles.find((article) => article.id === id)).filter((article) => article !== undefined).map((article) => `<a class="theme-article" href="${escapeAttr(article.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(article.title)}</strong><span>${escapeHtml(article.source)}${article.publishedAt ? ` · ${escapeHtml(new Date(article.publishedAt).toLocaleDateString())}` : ""}</span></a>`).join("")}</div>${group.ideas.map((idea) => `<article class="theme-idea"><h4>${escapeHtml(idea.title)}</h4><p>${escapeHtml(idea.summary)}</p><p><strong>Aplicação:</strong> ${escapeHtml(idea.application)}</p><button type="button" class="btn btn-secondary" data-save-idea="${escapeAttr(idea.id)}">Salvar ideia</button></article>`).join("")}</section>`).join("")}</div>${sourceNotes(briefing)}`;
  root.querySelectorAll<HTMLButtonElement>("[data-save-idea]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await window.themeResearch.saveIdea({ searchId: briefing.searchId, ideaId: button.dataset.saveIdea! });
        button.textContent = "Salva";
        await refreshIdeasView();
      } catch (error) {
        button.disabled = false;
        button.textContent = error instanceof Error ? error.message : "Falha ao salvar";
      }
    });
  });
}

function sourceNotes(briefing: ThemeBriefing): string {
  const statuses = Object.entries(briefing.sources).map(([source, value]) => `${source}: ${value.state} (${value.fetched})`).join(" · ");
  const errors = briefing.notices.map(escapeHtml).join(" ");
  return `<p class="theme-source-notes">${escapeHtml(statuses)}${errors ? `<br>${errors}` : ""}</p>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
const escapeAttr = escapeHtml;
