import {
  button,
  el,
  errorText,
  evidenceShortLabel,
  formatDate,
  icons,
  purposeLabels,
  purposes,
  shortDate,
  statusLabels,
  toast,
} from "./ideas-ui";

const api = () => window.projectIdeas;
const root = () => document.querySelector<HTMLElement>("#ideas-view")!;

let filter: IdeaPurpose | null = null;
let items: IdeaHistoryItem[] = [];
let selected: string | null = null;
let detail: IdeaView | null = null;
let comparison: ComparisonView | null = null;
let viewer: { label: string; text: string } | null = null;
let lastFailure: {
  operationId: string;
  articleTitle: string;
  error: string;
} | null = null;
let dismissedFailure: string | null = null;
let refreshedAt: Date | null = null;
let message = "";
let working = false;
let reloadPending = false;
let reviewOperation: (operationId: string) => void = () => undefined;
let feedTitle: (contentId: string) => string | undefined = () => undefined;

export function setIdeasViewHandlers(next: {
  reviewOperation: (operationId: string) => void;
  feedTitle?: (contentId: string) => string | undefined;
}) {
  reviewOperation = next.reviewOperation;
  if (next.feedTitle) feedTitle = next.feedTitle;
}

async function act(action: () => Promise<void>) {
  working = true;
  message = "";
  render();
  try {
    await action();
  } catch (error) {
    message = errorText(error);
  }
  working = false;
  render();
  if (reloadPending) {
    reloadPending = false;
    if (!root().hidden) await act(load);
  }
}

async function load() {
  const [history, last] = await Promise.all([
    api().history(),
    api()
      .getStatus()
      .catch(() => null),
  ]);
  items = history;
  refreshedAt = new Date();
  lastFailure =
    last &&
    last.operation.contextMode === "full" &&
    last.operation.state === "failed" &&
    last.operation.id !== dismissedFailure
      ? {
          operationId: last.operation.id,
          articleTitle:
            (last.operation.contentId
              ? feedTitle(last.operation.contentId)
              : undefined) ??
            last.operation.article?.title ??
            "um artigo",
          error: last.operation.error ?? "erro desconhecido",
        }
      : null;
  const visible = items.filter((item) => !filter || item.purpose === filter);
  if (!selected || !visible.some((item) => item.operationId === selected))
    selected = visible[0]?.operationId ?? null;
  detail = selected ? await api().view(selected) : null;
  comparison = detail?.evaluation
    ? await api()
        .comparison(selected!)
        .catch(() => null)
    : null;
}

export async function showIdeasView(operationId?: string) {
  root().hidden = false;
  if (operationId) {
    filter = null;
    selected = operationId;
    viewer = null;
  }
  await act(load);
}

export function hideIdeasView() {
  root().hidden = true;
}

export async function refreshIdeasView() {
  if (root().hidden) return;
  if (working) {
    reloadPending = true;
    return;
  }
  await act(load);
}

function isNew(item: IdeaHistoryItem) {
  return (
    item.rating === null && Date.now() - Date.parse(item.createdAt) < 86_400_000
  );
}

function renderFilters() {
  const count = (value: IdeaPurpose | null) =>
    items.filter((item) => !value || item.purpose === value).length;
  const seg = (value: IdeaPurpose | null, label: string) => {
    const node = button(
      `${label} · ${count(value)}`,
      () => {
        filter = value;
        selected = null;
        viewer = null;
        void act(load);
      },
      "seg",
    );
    node.setAttribute("aria-pressed", String(filter === value));
    return node;
  };
  return el(
    "div",
    {
      className: "seg-group",
      attrs: { role: "group", "aria-label": "Filtrar por intuito" },
    },
    seg(null, "Todas"),
    ...purposes.map((value) => seg(value, purposeLabels[value])),
  );
}

function renderCard(item: IdeaHistoryItem) {
  const card = el(
    "button",
    {
      className: `idea-card ${selected === item.operationId ? "selected" : ""}`,
      attrs: {
        type: "button",
        "aria-pressed": String(selected === item.operationId),
      },
    },
    el(
      "span",
      { className: "idea-card-chips" },
      isNew(item)
        ? el("span", { className: "chip chip-new", text: "Novo" })
        : null,
      el("span", { className: "chip", text: purposeLabels[item.purpose] }),
      item.contextRevoked
        ? el("span", { className: "chip", text: "contexto revogado" })
        : null,
    ),
    el("span", { className: "idea-card-title", text: item.title }),
    el("span", {
      className: "idea-card-meta",
      text: `De: ${item.articleTitle} · ${shortDate(item.createdAt)}${item.rating ? ` · nota ${item.rating}` : ""}`,
    }),
  );
  card.addEventListener("click", () => {
    selected = item.operationId;
    viewer = null;
    void act(load);
  });
  return card;
}

function renderComparisonAction(operationId: string) {
  if (!detail || detail.operation.contextMode !== "full") return null;
  if (!detail.evaluation)
    return button(
      "Comparar sem contexto",
      () =>
        void act(async () => {
          const next = await api().startComparison(operationId);
          reviewOperation(next.operation.id);
        }),
      "btn",
      working,
    );
  if (!comparison?.ready)
    return el("span", {
      className: "muted",
      attrs: { style: "font-size: 13px" },
      text: "Comparação sem contexto em andamento.",
    });
  return null;
}

function renderComparisonBlock() {
  if (!comparison?.ready || !comparison.a || !comparison.b) return null;
  const current = comparison;
  const version = (label: string, value: ComparisonVersion) =>
    el(
      "div",
      { className: "compare-version" },
      el("h4", {
        text: `Versão ${label} · ${statusLabels[value.status] ?? value.status}`,
      }),
      value.status === "recommendation"
        ? el("p", {
            attrs: { style: "margin: 0; font-weight: 500" },
            text: value.title,
          })
        : null,
      el("p", {
        attrs: { style: "margin: 0" },
        text: value.description || value.limitations.join(" "),
      }),
      value.stack.length
        ? el("span", {
            className: "muted",
            text: value.stack.map((item) => item.name).join(", "),
          })
        : null,
    );
  const choose = (choice: "A" | "B" | "tie") =>
    button(
      choice === "tie" ? "Empate" : `Prefiro ${choice}`,
      () =>
        void act(async () => {
          comparison = await api().recordPreference(
            current.evaluationId,
            choice,
          );
        }),
      current.preference === choice ? "cta" : "btn",
      working || current.preference !== null,
    );
  return el(
    "section",
    { className: "comparison" },
    el("div", { className: "label", text: "Comparação às cegas" }),
    el(
      "div",
      { className: "compare-grid" },
      version("A", current.a!),
      version("B", current.b!),
    ),
    el(
      "div",
      { className: "reading-actions" },
      choose("A"),
      choose("B"),
      choose("tie"),
      current.reveal
        ? el("span", {
            className: "muted",
            text: `A = ${current.reveal.a} · B = ${current.reveal.b}`,
          })
        : null,
    ),
  );
}

function renderTerms(terms: IdeaTermView[]) {
  if (!terms.length) return null;
  const answer = (term: string, known: boolean) =>
    void act(async () => {
      await api().answerKnowledge(term, known);
      detail = selected ? await api().view(selected) : detail;
      toast(
        known
          ? `Anotado na memória: você já conhece ${term}.`
          : `Anotado na memória: você ainda não conhece ${term}. As próximas ideias vão explicar melhor.`,
      );
    });
  const row = (term: IdeaTermView) => {
    const memory = term.knowledge;
    const question = !memory
      ? el(
          "div",
          { className: "term-question" },
          el("span", { text: `Você já conhece ou já usou ${term.name}?` }),
          button("Sim", () => answer(term.name, true), "btn btn-sm", working),
          button("Não", () => answer(term.name, false), "btn btn-sm", working),
        )
      : !memory.known
        ? el(
            "div",
            { className: "term-question" },
            el("span", {
              text: `Na memória "${memory.text}" você disse que não conhecia. Já sabe o que é?`,
            }),
            button(
              "Sim, já sei",
              () => answer(term.name, true),
              "btn btn-sm",
              working,
            ),
          )
        : el(
            "div",
            { className: "term-known" },
            el("span", { text: "Você já conhece." }),
            button(
              "Na verdade, não conheço",
              () => answer(term.name, false),
              "text-btn",
              working,
            ),
          );
    return el(
      "li",
      { className: `term ${memory && !memory.known ? "term-unknown" : ""}` },
      el("strong", { text: term.name }),
      term.explanation ? el("p", { text: term.explanation }) : null,
      question,
    );
  };
  const pending = terms.filter((term) => !term.knowledge).length;
  return el(
    "div",
    { className: "idea-section" },
    el("div", { className: "label", text: "Termos desta ideia" }),
    pending
      ? el("p", {
          className: "muted",
          attrs: { style: "margin: 0; font-size: 13px" },
          text: "Responda para o Loounp saber o que você já conhece. Isso fica na sua memória e você pode mudar depois.",
        })
      : null,
    el("ul", { className: "terms" }, ...terms.map(row)),
  );
}

function renderDetail() {
  if (!detail?.recommendation || !selected)
    return el(
      "div",
      { className: "library-empty" },
      el("p", {
        text: items.length
          ? "Selecione uma ideia."
          : "Nenhuma ideia ainda. No feed, abra um artigo e clique em Gerar ideia.",
      }),
    );
  const operationId = selected;
  const recommendation = detail.recommendation;
  const cited = new Map(
    recommendation.citedEvidence.map((item) => [item.id, item]),
  );
  const refs = (ids: string[]) =>
    ids.map((evidenceId) => {
      const item = cited.get(evidenceId);
      if (!item) return null;
      const ref = el("button", {
        className: "ref",
        text: evidenceShortLabel(item.label),
        attrs: { type: "button", title: item.label },
      });
      ref.addEventListener(
        "click",
        () =>
          void act(async () => {
            const read = await api().readEvidence(operationId, evidenceId);
            viewer = {
              label: `${read.label}${read.version ? ` · versão consultada em ${formatDate(read.version.modifiedAt)}` : ""}`,
              text: read.text,
            };
          }),
      );
      return ref;
    });
  const rating = recommendation.rating?.score ?? 0;
  const stars = el(
    "div",
    {
      className: "stars",
      attrs: { role: "radiogroup", "aria-label": "Nota de 1 a 5" },
    },
    ...[1, 2, 3, 4, 5].map((value) => {
      const filled = value <= rating;
      const star = el("button", {
        className: "star",
        html: icons.star
          .replace("FILL", filled ? "#2B45F0" : "none")
          .replace("STROKE", filled ? "#2B45F0" : "#8791A6"),
        attrs: {
          type: "button",
          role: "radio",
          "aria-checked": String(value === rating),
          "aria-label": `Nota ${value}`,
        },
      });
      star.disabled = working;
      star.addEventListener(
        "click",
        () =>
          void act(async () => {
            detail = await api().rate({ operationId, score: value });
            items = await api().history();
            toast(`Nota ${value} salva.`);
          }),
      );
      return star;
    }),
  );
  return el(
    "article",
    { className: "library-detail" },
    recommendation.contextRevoked
      ? el("div", {
          className: "notice notice-warn",
          text: "Esta ideia usou contexto pessoal depois revogado.",
        })
      : null,
    el(
      "div",
      { className: "idea-detail-head" },
      el(
        "div",
        { className: "idea-card-chips" },
        el("span", {
          className: "chip",
          text:
            recommendation.modality === "improvement"
              ? "Melhoria de projeto"
              : "Projeto novo",
        }),
        el("span", {
          className: "chip",
          text: purposeLabels[detail.operation.purpose],
        }),
        el("span", {
          className: "chip",
          text: `${recommendation.model} · ${formatDate(recommendation.createdAt)}`,
        }),
      ),
      el("h2", { text: recommendation.title }),
      el("span", {
        className: "muted",
        attrs: { style: "font-size: 13px" },
        text: `A partir de: ${detail.operation.article?.title ?? ""}`,
      }),
    ),
    el(
      "div",
      { className: "idea-columns" },
      el(
        "div",
        { className: "idea-col" },
        recommendation.summary
          ? el(
              "div",
              { className: "idea-summary" },
              el("div", { className: "label", text: "Em poucas palavras" }),
              el("p", { text: recommendation.summary }),
            )
          : null,
        el(
          "div",
          { className: "idea-section" },
          el("div", { className: "label", text: "A ideia" }),
          el("p", { text: recommendation.description }),
        ),
        recommendation.firstVersion
          ? el(
              "div",
              { className: "idea-section" },
              el("div", { className: "label", text: "Primeira versão" }),
              el("p", { text: recommendation.firstVersion }),
            )
          : null,
        recommendation.effort
          ? el(
              "div",
              { className: "idea-section" },
              el("div", { className: "label", text: "Esforço" }),
              el("p", {
                text: `${recommendation.effort.estimate}${recommendation.effort.assumptions.length ? ` · premissas: ${recommendation.effort.assumptions.join("; ")}` : ""}`,
              }),
            )
          : null,
        renderTerms(recommendation.terms ?? []),
        recommendation.stack.length
          ? el(
              "div",
              { className: "idea-section" },
              el("div", { className: "label", text: "Stack" }),
              ...recommendation.stack.map((item) =>
                el(
                  "div",
                  { className: "stack-line" },
                  el("strong", { text: item.name }),
                  el("span", {
                    className: "muted",
                    text: ` · ${item.justification}`,
                  }),
                ),
              ),
            )
          : null,
      ),
      el(
        "div",
        { className: "idea-col" },
        el(
          "div",
          { className: "idea-section" },
          el("div", {
            className: "label",
            text: "Por que faz sentido para você",
          }),
          el(
            "ul",
            {},
            ...recommendation.reasons.map((reason) =>
              el(
                "li",
                {},
                `${reason.text}${reason.inferred ? " (inferência)" : ""}`,
                ...refs(reason.evidenceIds),
              ),
            ),
          ),
        ),
        recommendation.limitations.length
          ? el(
              "div",
              { className: "idea-section" },
              el("div", { className: "label", text: "Limitações" }),
              el(
                "ul",
                { className: "notes" },
                ...recommendation.limitations.map((item) =>
                  el("li", { text: item }),
                ),
              ),
            )
          : null,
        viewer
          ? el(
              "div",
              { className: "idea-section" },
              el("div", { className: "label", text: viewer.label }),
              el("pre", { className: "excerpt", text: viewer.text }),
            )
          : null,
      ),
    ),
    renderComparisonBlock(),
    el(
      "div",
      { className: "idea-foot" },
      el(
        "div",
        { className: "rating" },
        el("span", { text: "Quão útil é esta ideia?" }),
        stars,
      ),
      el("span", { className: "push" }),
      renderComparisonAction(operationId),
      button(
        "Excluir",
        () => {
          if (
            !window.confirm(
              "Excluir esta ideia? O resultado, os trechos citados e a comparação ligada a ela serão removidos. Não é possível desfazer.",
            )
          )
            return;
          void act(async () => {
            await api().deleteIdea(operationId);
            selected = null;
            await load();
            toast("Ideia excluída.");
          });
        },
        "text-btn danger",
        working,
      ),
    ),
  );
}

function render() {
  if (root().hidden) return;
  const visible = items.filter((item) => !filter || item.purpose === filter);
  root().replaceChildren(
    ...[
      el(
        "header",
        { className: "page-head" },
        el(
          "div",
          { className: "page-head-row" },
          el(
            "div",
            {},
            el("h1", { text: "Suas ideias" }),
            refreshedAt
              ? el("p", {
                  text: `Atualizado às ${refreshedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
                })
              : null,
          ),
          el("button", {
            className: "btn",
            html: `${icons.refresh}<span>${working ? "Atualizando…" : "Atualizar"}</span>`,
            attrs: {
              type: "button",
              "aria-label": "Atualizar lista de ideias",
            },
          }),
        ),
        renderFilters(),
      ),
      lastFailure
        ? el(
            "div",
            { className: "page-messages" },
            el(
              "div",
              { className: "notice notice-err", attrs: { role: "status" } },
              el("span", {
                attrs: { style: "flex-grow: 1" },
                text: `A última geração ("${lastFailure.articleTitle}") não virou ideia: ${lastFailure.error}`,
              }),
              button(
                "Dispensar",
                () => {
                  dismissedFailure = lastFailure!.operationId;
                  lastFailure = null;
                  render();
                },
                "text-btn",
              ),
            ),
          )
        : null,
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
        { className: "library" },
        el(
          "div",
          { className: "library-list" },
          ...(visible.length
            ? visible.map(renderCard)
            : [
                el("p", {
                  className: "muted",
                  text: filter
                    ? "Nenhuma ideia com este intuito."
                    : "Nenhuma ideia gerada ainda.",
                }),
              ]),
        ),
        renderDetail(),
      ),
    ].filter((node): node is HTMLElement => Boolean(node)),
  );
  const refresh = root().querySelector<HTMLButtonElement>(
    ".page-head-row .btn",
  );
  if (refresh) {
    refresh.disabled = working;
    refresh.addEventListener("click", () => void act(load));
  }
}
