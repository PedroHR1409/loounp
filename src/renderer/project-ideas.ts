import { button, coverageLabels, el, errorText, iconButton, icons, kindLabels, purposeLabels, purposes } from './ideas-ui'

type ArticleRef = { id: string; title: string; url: string }
type Handlers = { onOpenIdea: (operationId: string) => void; onGenerationStarted: (operationId: string, contentId: string | null) => void }

const api = () => window.projectIdeas
const panel = () => document.querySelector<HTMLElement>('#idea-panel')!
const feedView = () => document.querySelector<HTMLElement>('#feed-view')!

const progressLabels: Record<string, string> = {
  created: 'Preparando…', acquiring_article: 'Capturando o artigo…', retrieving_context: 'Buscando contexto nos seus projetos…',
  generating: 'Gerando a ideia…', validating: 'Validando a ideia e as citações…',
}

let article: ArticleRef | null = null
let view: IdeaView | null = null
let liveState: string | null = null
let working = false
let message = ''
let notice = ''
let openRemoval: string | null = null
let pasteOpen = false
let handlers: Handlers = { onOpenIdea: () => undefined, onGenerationStarted: () => undefined }

export function setIdeaPanelHandlers(next: Handlers) {
  handlers = next
}

export const isIdeaPanelOpen = () => !panel().hidden

const running = (state?: string | null) => Boolean(state && ['created', 'acquiring_article', 'retrieving_context', 'generating', 'validating'].includes(state))

async function act(action: () => Promise<void>) {
  working = true
  message = ''
  notice = ''
  render()
  try { await action() } catch (error) { message = errorText(error) }
  working = false
  render()
}

function show() {
  panel().hidden = false
  feedView().classList.add('with-panel')
}

export function closeIdeaPanel() {
  panel().hidden = true
  feedView().classList.remove('with-panel')
  openRemoval = null
  pasteOpen = false
}

function step(label: string, ...children: Array<Node | string | null | false | undefined>) {
  return el('div', { className: 'idea-step' }, el('div', { className: 'label', text: label }), ...children)
}

function renderHead() {
  const title = view?.operation.article?.title ?? article?.title ?? 'Nova ideia'
  return el('header', { className: 'idea-panel-head' },
    el('div', { attrs: { style: 'display: flex; flex-direction: column; gap: 6px; flex-grow: 1; min-width: 0' } },
      el('div', { className: 'label', text: view?.operation.contextMode === 'article_only' ? 'Versão sem contexto (Gate 3)' : 'Nova ideia' }),
      el('h2', { text: title })),
    iconButton(icons.close, 'Fechar painel', () => closeIdeaPanel(), 'icon-btn'))
}

function renderProgress() {
  const state = view?.operation.state ?? liveState
  if (!running(state) && !(working && !view)) return null
  return el('div', { className: 'progress-box', attrs: { role: 'status' } },
    el('span', { className: 'spin', attrs: { 'aria-hidden': 'true' } }),
    el('strong', { text: progressLabels[state ?? 'created'] ?? 'Processando…' }),
    view && running(view.operation.state) ? button('Cancelar', () => void act(async () => { view = await api().cancel(view!.operation.id) }), 'btn btn-sm') : null)
}

function renderBusyOther() {
  if (!view?.busy || view.operation.contentId === article?.id) return null
  return el('div', { className: 'progress-box' },
    el('span', { className: 'spin', attrs: { 'aria-hidden': 'true' } }),
    el('strong', { text: `Uma ideia está sendo gerada para "${view.operation.article?.title ?? 'outro artigo'}". Uma geração por vez.` }),
    button('Cancelar e gerar esta', () => void act(async () => { await api().cancel(view!.operation.id); await start() }), 'btn btn-sm'))
}

function renderArticleStep() {
  const operation = view!.operation
  const captured = operation.article
  const needsText = operation.state === 'awaiting_article_text'
  const incomplete = needsText || (captured && (captured.coverage === 'partial' || captured.coverage === 'metadata_only'))
  const text = el('textarea', { attrs: { rows: '6', maxlength: '160000', placeholder: 'Cole aqui o texto completo do artigo (mínimo de 200 caracteres). Útil para artigos pagos do Medium, que chegam incompletos pelo RSS.', 'aria-label': 'Texto do artigo' } })
  const paste = el('div', { attrs: { style: 'display: flex; flex-direction: column; gap: 8px' } }, text,
    button('Usar este texto', () => void act(async () => { view = await api().submitText({ operationId: operation.id, text: text.value }); pasteOpen = false }), 'btn', working))
  const status = incomplete
    ? el('div', { className: 'notice notice-warn' }, el('span', { html: icons.warn }),
      el('span', { attrs: { style: 'flex-grow: 1' }, text: needsText ? (operation.error ?? 'Não foi possível capturar o texto. Cole o conteúdo para continuar.') : `Captura ${coverageLabels[captured!.coverage] ?? captured!.coverage}: ${captured!.limitations[0] ?? 'o texto pode estar incompleto.'}` }),
      needsText ? null : button(pasteOpen ? 'Fechar' : 'Colar texto completo', () => { pasteOpen = !pasteOpen; render() }, 'btn btn-sm'))
    : el('div', { className: 'notice notice-ok' }, el('span', { html: icons.check }),
      el('span', { attrs: { style: 'flex-grow: 1' }, text: `${coverageLabels[captured?.coverage ?? 'main_text']} · ${captured?.characters.toLocaleString('pt-BR') ?? 0} caracteres` }),
      button(pasteOpen ? 'Fechar' : 'Colar outro texto', () => { pasteOpen = !pasteOpen; render() }, 'text-btn'))
  return step('1 · Artigo', status, needsText || pasteOpen ? paste : null)
}

function renderPurposeStep(pkg: NonNullable<IdeaView['package']>, operationId: string) {
  return step('2 · Intuito', el('div', { className: 'purpose-grid', attrs: { role: 'radiogroup', 'aria-label': 'Intuito do projeto' } }, ...purposes.map((value) => {
    const option = el('label', { className: `purpose-option ${pkg.purpose === value ? 'selected' : ''}` })
    const input = el('input', { attrs: { type: 'radio', name: 'idea-purpose', value } })
    input.checked = pkg.purpose === value
    input.disabled = working
    input.addEventListener('change', () => void act(async () => { view = await api().setPurpose({ operationId, packageId: pkg.id, purpose: value }) }))
    option.append(input, document.createTextNode(purposeLabels[value]))
    return option
  })))
}

function renderItem(item: PackageItemView, operationId: string, packageId: string, label: string, lines: string | null) {
  const open = openRemoval === item.id
  const row = el('div', { className: 'src-item-row' },
    item.kind === 'evidence' ? el('span', { className: 'muted', html: icons.file }) : null,
    el('details', {}, el('summary', { text: label }), el('pre', { className: 'excerpt', text: item.text })),
    lines ? el('span', { className: 'src-lines', text: lines }) : null,
    iconButton(icons.smallClose, open ? 'Fechar opções' : `Remover ${label}`, () => { openRemoval = open ? null : item.id; render() }, 'remove-x', working))
  const choose = (scope: 'once' | 'always', text: string) => button(text, () => void act(async () => {
    view = await api().removeItem({ operationId, packageId, itemId: item.id, scope })
    openRemoval = null
    notice = scope === 'always' ? `${item.relativePath ?? 'Memória'} não será usado nas próximas ideias. Desfaça em Contexto › Ignorados.` : 'Removido só desta ideia.'
  }), `btn btn-sm ${scope === 'always' ? 'always' : ''}`, working)
  return el('div', { className: `src-item ${open ? 'open' : ''}` }, row,
    open ? el('div', { className: 'remove-choices' }, el('span', { text: item.kind === 'memory' ? 'Remover esta memória' : 'Remover este arquivo' }), choose('once', 'Só agora'), choose('always', 'Sempre ignorar')) : null)
}

function renderContextStep(pkg: NonNullable<IdeaView['package']>, operationId: string) {
  const evidence = pkg.items.filter((item) => item.kind === 'evidence')
  const memories = pkg.items.filter((item) => item.kind === 'memory')
  const byProject = new Map<string, PackageItemView[]>()
  for (const item of evidence) byProject.set(item.projectLabel ?? 'projeto', [...(byProject.get(item.projectLabel ?? 'projeto') ?? []), item])
  const files = evidence.length
    ? [...byProject].flatMap(([project, items]) => [el('div', { className: 'context-group', text: project }), ...items.map((item) => renderItem(item, operationId, pkg.id, (item.relativePath ?? '').replace(`${project}/`, ''), item.lines))])
    : [el('p', { className: 'panel-sub', text: pkg.projectsConsulted ? 'Nenhum arquivo dos seus projetos combina com este artigo.' : 'Projetos não consultados: ative a leitura em Contexto.' })]
  const mems = memories.length
    ? memories.map((item) => renderItem(item, operationId, pkg.id, item.text, kindLabels[item.memoryKind ?? 'goal'] ?? null))
    : [el('p', { className: 'panel-sub', text: 'Nenhuma memória confirmada vai junto.' })]
  return step('3 · Contexto que vai junto',
    el('div', { className: 'muted', attrs: { style: 'font-size: 13px' }, text: `${evidence.length} arquivo(s) de ${byProject.size} projeto(s) · ${memories.length} memória(s)` }),
    el('div', { className: 'context-grid' },
      el('div', { className: 'context-col' }, ...files),
      el('div', { className: 'context-col' }, el('div', { className: 'context-group', text: 'Suas memórias' }), ...mems)),
    pkg.notices.filter((item) => !item.startsWith('Texto fornecido')).length ? el('ul', { className: 'notes' }, ...pkg.notices.filter((item) => !item.startsWith('Texto fornecido')).map((item) => el('li', { text: item }))) : null)
}

function renderMessages() {
  if (!notice && !message) return null
  return el('div', { className: 'panel-messages' },
    notice ? el('div', { className: 'notice notice-info', text: notice, attrs: { role: 'status' } }) : null,
    message ? el('div', { className: 'notice notice-err', text: message, attrs: { role: 'alert' } }) : null)
}

function renderFoot(pkg: NonNullable<IdeaView['package']>, operationId: string) {
  const model = view!.modelConfig
  const modelName = el('input', { className: 'field', attrs: { type: 'text', value: model.model, 'aria-label': 'Modelo' } })
  const tokens = el('input', { className: 'field', attrs: { type: 'number', min: '8000', step: '1000', placeholder: 'Janela de contexto (tokens)', 'aria-label': 'Janela de contexto do modelo' } })
  const evidenceCount = pkg.items.filter((item) => item.kind === 'evidence').length
  const memoryCount = pkg.items.filter((item) => item.kind === 'memory').length
  const generate = button('Gerar ideia', () => void act(async () => {
    try {
      const next = await api().authorize({ operationId, packageId: pkg.id, reviewToken: pkg.reviewToken, payloadSha256: pkg.payloadSha256 })
      view = next
      if (next.operation.state === 'generating') {
        handlers.onGenerationStarted(next.operation.id, next.operation.contentId)
        closeIdeaPanel()
      }
    } catch (error) {
      const text = errorText(error)
      if (/mudou|vigente|não corresponde|não está mais confirmada/.test(text)) {
        view = await api().rebuild(operationId)
        notice = 'O contexto mudou desde que foi exibido. Confira o pacote atualizado e clique em Gerar ideia.'
        return
      }
      throw error
    }
  }), 'cta', working || !model.contextTokens)
  return el('footer', { className: 'idea-panel-foot' },
    renderMessages(),
    model.contextTokens ? null : el('div', { className: 'model-setup' },
      el('div', { className: 'notice notice-warn', attrs: { style: 'width: 100%' }, text: 'Informe a janela de contexto do modelo antes de gerar.' }),
      modelName, tokens,
      button('Salvar modelo', () => void act(async () => {
        await api().setModel({ model: modelName.value.trim(), contextTokens: Number(tokens.value) })
        view = await api().view(operationId)
        notice = 'Modelo salvo.'
      }), 'btn', working)),
    el('div', { className: 'send' },
      el('strong', { text: `Será enviado ao ${pkg.provider === 'openai' ? 'OpenAI' : pkg.provider} · ${pkg.model}` }),
      el('span', { text: `Artigo + ${evidenceCount} trecho(s) + ${memoryCount} memória(s) · cerca de ${pkg.estimatedTokens.toLocaleString('pt-BR')} tokens · nada mais sai do seu computador` })),
    button('Cancelar', () => void act(async () => { view = await api().deny(operationId); closeIdeaPanel() }), 'btn', working),
    generate)
}

function renderOutcome() {
  const operation = view?.operation
  if (!operation || view!.busy || running(operation.state) || operation.state === 'awaiting_consent' || operation.state === 'awaiting_article_text') return null
  const recommendation = view!.recommendation
  if (operation.state === 'completed' && recommendation?.status === 'recommendation') {
    return el('div', { className: 'progress-box' }, el('span', { className: 'muted', html: icons.check }), el('strong', { text: `Ideia pronta: ${recommendation.title}` }),
      button('Abrir ideia', () => { closeIdeaPanel(); handlers.onOpenIdea(operation.id) }, 'cta'))
  }
  if (operation.state === 'completed' && recommendation) {
    return el('div', { className: 'idea-step' },
      el('div', { className: 'notice notice-info', text: recommendation.status === 'no_application' ? 'Nenhuma aplicação convincente para seus projetos.' : 'Contexto insuficiente para uma boa ideia.' }),
      el('ul', { className: 'notes' }, ...recommendation.limitations.map((item) => el('li', { text: item }))),
      article ? button('Tentar de novo', () => void act(start), 'btn', working) : null)
  }
  return el('div', { className: 'idea-step' },
    el('div', { className: 'notice notice-err', text: operation.error ?? (operation.state === 'canceled' ? 'Geração cancelada.' : 'Não foi possível gerar a ideia.') }),
    article ? button('Tentar de novo', () => void act(start), 'btn', working) : null)
}

function render() {
  if (!isIdeaPanelOpen()) return
  const operation = view?.operation
  const pkg = view?.package
  const reviewing = Boolean(operation && !view!.busy && (operation.state === 'awaiting_consent' || operation.state === 'awaiting_article_text'))
  const body = el('div', { className: 'idea-panel-body' },
    renderProgress(), renderBusyOther(), renderOutcome(),
    reviewing ? renderArticleStep() : null,
    reviewing && pkg && operation!.state === 'awaiting_consent' ? renderPurposeStep(pkg, operation!.id) : null,
    reviewing && pkg && operation!.state === 'awaiting_consent' ? renderContextStep(pkg, operation!.id) : null)
  const foot = reviewing && pkg && operation!.state === 'awaiting_consent' ? renderFoot(pkg, operation!.id) : (notice || message ? el('footer', { className: 'idea-panel-foot' }, renderMessages()) : null)
  panel().replaceChildren(...[renderHead(), body, foot].filter((node): node is HTMLElement => Boolean(node)))
  panel().querySelector('[role=alert], [role=status]')?.scrollIntoView({ block: 'nearest' })
}

async function start() {
  if (!article) return
  view = null
  liveState = 'acquiring_article'
  render()
  view = await api().start({ contentId: article.id })
  liveState = null
}

export async function openIdeaPanel(target: ArticleRef) {
  article = target
  message = ''
  notice = ''
  openRemoval = null
  pasteOpen = false
  show()
  await act(start)
}

export async function openIdeaPanelOperation(operationId: string) {
  article = null
  message = ''
  notice = ''
  show()
  await act(async () => { view = await api().view(operationId) })
}

export function handleIdeaEvent(event: IdeaEvent) {
  if (!isIdeaPanelOpen()) return
  const tracked = view?.operation.id === event.operationId || (!view && event.contentId === article?.id)
  if (!tracked) return
  if (event.type === 'state' && !view) { liveState = event.state; render(); return }
  if (working) return
  void api().view(event.operationId).then((next) => { view = { ...next, busy: false }; render() }).catch(() => undefined)
}
