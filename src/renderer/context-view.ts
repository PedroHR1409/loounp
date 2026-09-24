import {
  button,
  el,
  errorText,
  formatDate,
  kindLabels,
  toast,
} from "./ideas-ui";

const api = () => window.projectIdeas;
const root = () => document.querySelector<HTMLElement>("#context-view")!;

const isolationLabels: Record<string, string> = {
  ready: "Leitura isolada ativa · só leitura",
  disabled: "Isolamento aprovado · leitura desligada",
  blocked: "Isolamento aguardando validação",
  unavailable: "Isolamento indisponível",
};
const projectStatusLabels: Record<string, string> = {
  consulted: "consultado",
  pending: "parcial",
  cataloged: "catalogado",
  excluded: "excluído",
};

let memory: MemoryListView | null = null;
let context: ProjectContextStatus | null = null;
let ignored: IgnoredSourceView[] = [];
let message = "";
let working = false;
let onChanged: () => void = () => undefined;

export function setContextViewHandlers(next: { onChanged: () => void }) {
  onChanged = next.onChanged;
}

async function act(action: () => Promise<void>, changed = true) {
  working = true;
  message = "";
  render();
  try {
    await action();
    if (changed) onChanged();
  } catch (error) {
    message = errorText(error);
  }
  working = false;
  render();
}

async function load() {
  [memory, context, ignored] = await Promise.all([
    api().listMemory(),
    api().contextStatus(),
    api().ignored(),
  ]);
}

export async function showContextView() {
  root().hidden = false;
  await act(load, false);
}

export function hideContextView() {
  root().hidden = true;
}

export async function refreshContextView() {
  if (root().hidden || working) return;
  await act(load, false);
}

export function coverageSummaryText(
  lastCatalog: ProjectContextStatus["lastCatalog"],
): string {
  if (!lastCatalog) return "Desktop\\Projetos · ainda não catalogado";
  const { coverage, at } = lastCatalog;
  return `Desktop\\Projetos · atualizado ${formatDate(at)} · ${coverage.consulted.toLocaleString("pt-BR")} arquivos lidos, ${coverage.excluded.toLocaleString("pt-BR")} excluídos, ${coverage.secretBlockedChunks} trechos com segredo bloqueados`;
}

function renderProjects() {
  if (!context)
    return el(
      "section",
      { className: "context-panel" },
      el("h2", { text: "Seus projetos" }),
    );
  const state = context.isolation.state;
  return el(
    "section",
    {
      className: "context-panel",
      attrs: { "aria-labelledby": "ctx-projects" },
    },
    el(
      "div",
      { attrs: { style: "display: flex; flex-direction: column; gap: 6px" } },
      el("h2", { text: "Seus projetos", attrs: { id: "ctx-projects" } }),
      el(
        "div",
        { className: `status-line ${state === "ready" ? "ok" : "off"}` },
        el("span", { className: "dot" }),
        isolationLabels[state] ?? state,
      ),
      el("p", {
        className: "panel-sub",
        text: coverageSummaryText(context.lastCatalog),
      }),
      context.isolation.reasons.length
        ? el(
            "ul",
            { className: "notes" },
            ...context.isolation.reasons.map((reason) =>
              el("li", { text: reason }),
            ),
          )
        : null,
    ),
    el(
      "div",
      { className: "line-list" },
      ...context.projects.map((project) =>
        el(
          "div",
          { className: "line-item" },
          el("span", { text: project.label }),
          el("span", {
            className: "muted",
            attrs: { style: "font-size: 13px" },
            text: projectStatusLabels[project.status] ?? project.status,
          }),
          button(
            "Remover",
            () => {
              if (
                !window.confirm(
                  `Remover o contexto de ${project.label}? O índice e as ideias que citam esse projeto serão apagados; os arquivos do projeto não são tocados.`,
                )
              )
                return;
              void act(async () => {
                context = await api().removeProjectContext(project.id);
              });
            },
            "text-btn",
            working,
          ),
        ),
      ),
    ),
    el(
      "div",
      { className: "panel-actions" },
      state === "ready"
        ? button(
            "Atualizar projetos",
            () =>
              void act(async () => {
                const result = await api().refreshContext({});
                context = result.status;
                toast(
                  `Projetos atualizados: ${result.coverage.consulted.toLocaleString("pt-BR")} arquivos lidos.`,
                );
              }),
            "btn",
            working,
          )
        : null,
      state === "disabled"
        ? button(
            "Permitir leitura dos projetos",
            () =>
              void act(async () => {
                context = await api().setRealSources(true);
              }),
            "cta",
            working,
          )
        : null,
      state === "ready"
        ? button(
            "Desligar leitura",
            () =>
              void act(async () => {
                context = await api().setRealSources(false);
              }),
            "text-btn",
            working,
          )
        : null,
    ),
    el("p", {
      className: "panel-sub",
      attrs: { style: "font-size: 11px" },
      text: `Política de isolamento ${context.policySha256.slice(0, 12)}…`,
    }),
  );
}

function renderMemories() {
  const list = memory;
  const rows = (list?.memories ?? []).map((entry) => {
    const shown = entry.pending ?? entry.confirmed ?? entry.conflicted;
    if (!shown) return null;
    const pendingOnly = Boolean(entry.pending && !entry.confirmed);
    const toggle = entry.confirmed
      ? el("button", {
          className: "toggle",
          attrs: {
            type: "button",
            role: "switch",
            "aria-checked": String(!entry.ignoredInIdeas),
            "aria-label": `Usar nas ideias: ${shown.text}`,
          },
        })
      : null;
    if (toggle) {
      (toggle as HTMLButtonElement).disabled = working;
      toggle.addEventListener(
        "click",
        () =>
          void act(async () => {
            memory = await api().setMemoryIgnored(
              entry.memoryId,
              !entry.ignoredInIdeas,
            );
          }),
      );
    }
    const state = pendingOnly
      ? "proposta"
      : entry.pending
        ? "correção pendente"
        : entry.conflicted
          ? "em revisão"
          : entry.ignoredInIdeas
            ? "fora das ideias"
            : "confirmada";
    const meta = el(
      "div",
      { className: "memory-meta" },
      el("span", {
        text: `${kindLabels[shown.kind] ?? shown.kind} · ${state}${shown.origin === "interest_profile" ? " · dos interesses" : ""}`,
      }),
      entry.pending
        ? button(
            "Confirmar",
            () =>
              void act(async () => {
                memory = await api().confirmMemory({
                  memoryId: entry.memoryId,
                  revision: entry.pending!.revision,
                  expectedRevision: entry.latestRevision,
                });
              }),
            "text-btn",
            working,
          )
        : null,
      entry.pending
        ? button(
            "Descartar",
            () =>
              void act(async () => {
                memory = await api().discardMemory({
                  memoryId: entry.memoryId,
                  expectedRevision: entry.latestRevision,
                });
              }),
            "text-btn",
            working,
          )
        : null,
      button(
        "Corrigir",
        () => {
          const text = window.prompt(
            "Nova redação (fica pendente até você confirmar):",
            shown.text,
          );
          if (text)
            void act(async () => {
              memory = await api().correctMemory({
                memoryId: entry.memoryId,
                text,
                expectedRevision: entry.latestRevision,
              });
            });
        },
        "text-btn",
        working,
      ),
      entry.confirmed || entry.conflicted
        ? button(
            "Revogar",
            () =>
              void act(async () => {
                const result = await api().revokeMemory({
                  memoryId: entry.memoryId,
                  expectedRevision: entry.latestRevision,
                });
                memory = result;
                toast(result.notice);
              }),
            "text-btn",
            working,
          )
        : null,
      button(
        "Esquecer",
        () => {
          if (
            !window.confirm(
              "Esquecer remove o texto, as revisões e as ideias que dependem desta memória. Continuar?",
            )
          )
            return;
          void act(async () => {
            const result = await api().forgetMemory(entry.memoryId);
            memory = result;
            toast(result.notice);
          });
        },
        "text-btn danger",
        working,
      ),
    );
    return el(
      "div",
      {
        className: `memory-item ${entry.ignoredInIdeas || pendingOnly ? "dim" : ""}`,
      },
      el(
        "div",
        { className: "memory-row" },
        el("span", { text: shown.text }),
        toggle,
      ),
      meta,
    );
  });
  const kind = el(
    "select",
    {
      className: "field",
      attrs: {
        "aria-label": "Tipo da memória",
        style: "width: auto; flex-grow: 0",
      },
    },
    ...(list?.kinds ?? ["goal"]).map((value) =>
      el("option", { text: kindLabels[value] ?? value, attrs: { value } }),
    ),
  );
  const text = el("input", {
    className: "field",
    attrs: {
      type: "text",
      maxlength: "1200",
      placeholder: "Ex.: Quero demonstrar RAG em portfólio",
      "aria-label": "Nova memória",
    },
  });
  return el(
    "section",
    {
      className: "context-panel",
      attrs: { "aria-labelledby": "ctx-memories" },
    },
    el(
      "div",
      { attrs: { style: "display: flex; flex-direction: column; gap: 6px" } },
      el("h2", { text: "Suas memórias", attrs: { id: "ctx-memories" } }),
      el("p", {
        className: "panel-sub",
        text: "Afirmações que você confirmou. Desligue para não usar nas ideias, sem apagar.",
      }),
    ),
    el(
      "div",
      { className: "line-list" },
      ...(rows.some(Boolean)
        ? rows
        : [
            el("p", { className: "panel-sub", text: "Nenhuma memória ainda." }),
          ]),
    ),
    el(
      "div",
      {
        className: "panel-actions",
        attrs: { style: "flex-direction: column; align-items: stretch" },
      },
      el(
        "div",
        { className: "inline-form" },
        kind,
        text,
        button(
          "Adicionar",
          () =>
            void act(async () => {
              const value = text.value.replace(/\s+/g, " ").trim();
              const proposed = await api().proposeMemory({
                kind: kind.value as MemoryKindName,
                text: value,
              });
              const created = proposed.memories.find(
                (entry) => entry.pending?.text === value,
              );
              memory = created
                ? await api().confirmMemory({
                    memoryId: created.memoryId,
                    revision: created.pending!.revision,
                    expectedRevision: created.latestRevision,
                  })
                : proposed;
            }),
          "btn",
          working,
        ),
      ),
      button(
        "Sugerir a partir dos meus interesses",
        () =>
          void act(async () => {
            memory = await api().proposeMemory({ fromInterests: true });
          }),
        "link-button",
        working,
      ),
    ),
  );
}

function renderIgnored() {
  return el(
    "section",
    { className: "context-panel", attrs: { "aria-labelledby": "ctx-ignored" } },
    el(
      "div",
      { attrs: { style: "display: flex; flex-direction: column; gap: 6px" } },
      el("h2", { text: "Ignorados", attrs: { id: "ctx-ignored" } }),
      el("p", {
        className: "panel-sub",
        text: "Arquivos e memórias que você pediu para nunca enviar. Continuam no disco; só não entram nas ideias.",
      }),
    ),
    el(
      "div",
      { className: "line-list" },
      ...(ignored.length
        ? ignored.map((item) =>
            el(
              "div",
              { className: "line-item" },
              el("span", {
                text:
                  item.kind === "file"
                    ? (item.relativePath ?? item.label)
                    : `Memória: ${item.label}`,
              }),
              button(
                "Voltar a usar",
                () =>
                  void act(async () => {
                    ignored = await api().unignore(item.id);
                    memory = await api().listMemory();
                  }),
                "btn btn-sm",
                working,
              ),
            ),
          )
        : [
            el("p", {
              className: "panel-sub",
              text: 'Nada ignorado. Ao remover um item de uma ideia, escolha "Sempre ignorar".',
            }),
          ]),
    ),
  );
}

function render() {
  if (root().hidden) return;
  root().replaceChildren(
    ...[
      el(
        "header",
        { className: "page-head" },
        el("h1", { text: "O que o Loounp sabe sobre você" }),
        el("p", {
          text: "Tudo o que pode acompanhar um artigo quando você gera uma ideia. Nada aqui sai do computador sem a sua revisão.",
        }),
      ),
      message
        ? el(
            "div",
            { className: "page-messages" },
            el("div", {
              className: "notice notice-err",
              text: message,
              attrs: { role: "alert" },
            }),
          )
        : null,
      el(
        "div",
        { className: "context-page" },
        renderProjects(),
        renderMemories(),
        renderIgnored(),
      ),
    ].filter((node): node is HTMLElement => Boolean(node)),
  );
}
