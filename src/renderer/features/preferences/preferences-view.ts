import { el, errorText, formatDate } from "../ideas/ideas-ui";

const api = () => window.contentApp;
const root = () => document.querySelector<HTMLElement>("#preferences-view")!;

const INTERVAL_LABELS: Record<number, string> = {
  0: "Desligado",
  6: "A cada 6 horas",
  12: "A cada 12 horas",
  24: "Diariamente",
};
const INTERVAL_OPTIONS = [0, 6, 12, 24];

let intervalHours = 0;
let dailyTime = "09:00";
let lastRefresh: string | null = null;
let working = false;
let message = "";

export function setPreferencesViewState(next: {
  discoveryIntervalHours: number;
  discoveryTimeGmtMinus3: string;
  lastRefresh: string | null;
}) {
  intervalHours = next.discoveryIntervalHours;
  dailyTime = next.discoveryTimeGmtMinus3;
  lastRefresh = next.lastRefresh;
}

export function showPreferencesView() {
  root().hidden = false;
  render();
}

export function hidePreferencesView() {
  root().hidden = true;
}

export function lastRefreshLabel(value: string | null): string {
  return value ? `Última busca: ${formatDate(value)}` : "Nenhuma busca ainda.";
}

async function applyInterval(value: number) {
  working = true;
  message = "";
  render();
  try {
    await api().setDiscoveryInterval(value);
    intervalHours = value;
  } catch (error) {
    message = errorText(error);
  }
  working = false;
  render();
}

async function applyDailyTime(value: string) {
  working = true;
  message = "";
  render();
  try {
    await api().setDiscoveryTimeGmtMinus3(value);
    dailyTime = value;
  } catch (error) {
    message = errorText(error);
  }
  working = false;
  render();
}

function render() {
  if (root().hidden) return;
  const select = el(
    "select",
    { className: "field", attrs: { "aria-label": "Busca automática" } },
    ...INTERVAL_OPTIONS.map((value) =>
      el("option", {
        text: INTERVAL_LABELS[value],
        attrs: {
          value: String(value),
          ...(value === intervalHours ? { selected: "" } : {}),
        },
      }),
    ),
  );
  select.disabled = working;
  select.addEventListener("change", () => void applyInterval(Number(select.value)));
  const dailyTimeInput = el("input", {
    className: "field",
    attrs: {
      type: "time",
      value: dailyTime,
      "aria-label": "Horário diário GMT-03:00",
    },
  });
  dailyTimeInput.disabled = working;
  dailyTimeInput.addEventListener("change", () =>
    void applyDailyTime(dailyTimeInput.value),
  );
  const dailyTimeField =
    intervalHours === 24
      ? el(
          "label",
          { className: "schedule-time-field" },
          el("span", { text: "Horário diário (GMT-03:00)" }),
          dailyTimeInput,
        )
      : null;
  root().replaceChildren(
    el(
      "header",
      { className: "page-head" },
      el("h1", { text: "Configurações" }),
      el("p", { text: "Preferências gerais do Loounp." }),
    ),
    ...(message
      ? [
          el(
            "div",
            { className: "page-messages" },
            el("div", {
              className: "notice notice-err",
              text: message,
              attrs: { role: "alert" },
            }),
          ),
        ]
      : []),
    el(
      "section",
      { className: "context-panel" },
      el("h2", { text: "Busca automática" }),
      el("p", {
        className: "panel-sub",
        text: "Busca artigos novos no Dev.to e no Medium automaticamente. No modo diário, roda no horário GMT-03:00 escolhido. Deixe o Loounp ativo na bandeja do Windows para receber avisos com a janela fechada.",
      }),
      select,
      dailyTimeField,
      el("p", {
        className: "panel-sub",
        attrs: { style: "font-size: 12px" },
        text: lastRefreshLabel(lastRefresh),
      }),
    ),
  );
}
