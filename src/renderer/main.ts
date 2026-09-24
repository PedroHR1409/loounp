import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import './style.css'
import { closeIdeaPanel, handleIdeaEvent, isIdeaPanelOpen, openIdeaPanel, openIdeaPanelOperation, setIdeaPanelHandlers } from './project-ideas'
import { hideIdeasView, refreshIdeasView, setIdeasViewHandlers, showIdeasView } from './ideas-view'
import { hideContextView, refreshContextView, setContextViewHandlers, showContextView } from './context-view'
import { outcomeLabels } from './ideas-ui'

type View = 'feed' | 'ideas' | 'context'
type Filter = 'all' | 'saved' | 'ideas'

const feed = document.querySelector<HTMLElement>('#feed')!
const readingPane = document.querySelector<HTMLElement>('#reading-pane')!
const feedView = document.querySelector<HTMLElement>('#feed-view')!
const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!
const toast = document.querySelector<HTMLElement>('#toast')!
const navButtons: Record<View, HTMLButtonElement> = {
  feed: document.querySelector<HTMLButtonElement>('#open-feed')!,
  ideas: document.querySelector<HTMLButtonElement>('#open-ideas')!,
  context: document.querySelector<HTMLButtonElement>('#open-context')!,
}
let state: AppState
let activeFilter: Filter = 'all'
let currentView: View = 'feed'
let selectedId: string | null = null
let toastTimer: number
let onboardingShown = false
let visibleCount = 20
let ideasByContent = new Map<string, number>()
let generating: { operationId: string; contentId: string | null } | null = null
let contextSummary: { projects: number; memories: number; isolation: string } | null = null
const topicMetadata = new WeakMap<HTMLElement, InterestProfileV2['interestGroups'][number]>()

const svg = {
  save: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"></path></svg>',
  useful: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7"></path></svg>',
  notUseful: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-2-2v-4H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17"></path></svg>',
  external: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"></path></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
  idea: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"></path></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>',
}

function isV2Profile(profile: AppState['profile'] | InterestProfileV2 | null | undefined): profile is InterestProfileV2 {
  return Boolean(profile && 'schemaVersion' in profile && profile.schemaVersion === 2)
}

function showToast() {
  toast.classList.add('show')
  window.clearTimeout(toastTimer)
}

function notify(message: string, undoContentId?: string, action?: { label: string; run: () => void }) {
  toast.className = ''
  toast.replaceChildren(document.createTextNode(message))
  if (undoContentId) {
    const undo = document.createElement('button')
    undo.textContent = 'Desfazer'
    undo.className = 'toast-undo'
    undo.type = 'button'
    undo.addEventListener('click', async () => {
      await window.contentApp.recordFeedback(undoContentId, 'unhide')
      await load()
      notify('O artigo voltou ao feed.')
    }, { once: true })
    toast.append(undo)
  }
  if (action) {
    const actionButton = document.createElement('button')
    actionButton.textContent = action.label
    actionButton.className = 'toast-undo'
    actionButton.type = 'button'
    actionButton.addEventListener('click', () => { toast.classList.remove('show'); action.run() }, { once: true })
    toast.append(actionButton)
  }
  showToast()
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), action || undoContentId ? 8000 : 3000)
}

function notifyIdea(title: string, articleTitle: string, operationId: string) {
  toast.className = 'toast-idea'
  const later = document.createElement('button')
  later.type = 'button'
  later.className = 'toast-undo'
  later.textContent = 'Depois'
  later.addEventListener('click', () => toast.classList.remove('show'), { once: true })
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'cta'
  open.textContent = 'Abrir ideia'
  open.addEventListener('click', () => { toast.classList.remove('show'); void showView('ideas', operationId) }, { once: true })
  const kicker = document.createElement('div')
  kicker.className = 'toast-kicker'
  kicker.innerHTML = svg.check
  kicker.append('IDEIA PRONTA')
  const heading = document.createElement('div')
  heading.className = 'toast-title'
  heading.textContent = title
  const sub = document.createElement('div')
  sub.className = 'toast-sub'
  sub.textContent = `A partir de "${articleTitle}"`
  const actions = document.createElement('div')
  actions.className = 'toast-actions'
  actions.append(later, open)
  toast.replaceChildren(kicker, heading, sub, actions)
  showToast()
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 15000)
}

window.addEventListener('loounp:toast', (event) => {
  const detail = (event as CustomEvent<{ message: string; action?: { label: string; run: () => void } }>).detail
  notify(detail.message, undefined, detail.action)
})

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

function relativeDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return 'data indisponível'
  const days = Math.floor((Date.now() - date.valueOf()) / 86400000)
  if (days <= 0) return 'hoje'
  if (days === 1) return 'ontem'
  if (days < 30) return `há ${days} dias`
  return date.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })
}

function categoryLabel(value: string | null) {
  const labels: Record<string, string> = {
    news: 'Notícia', 'deep-dive': 'Aprofundamento técnico', 'technical-deep-dive': 'Aprofundamento técnico',
    tutorial: 'Tutorial', opinion: 'Opinião', announcement: 'Anúncio', 'product-announcement': 'Anúncio de produto',
    other: 'Outro formato', uncertain: 'Classificação incerta', promotional: 'Sinais promocionais', repetitive: 'Sinais de repetição', uncategorized: 'Não classificado',
  }
  return value ? labels[value] ?? value : 'Análise editorial'
}

const sourceLabel = (source: ContentItem['source']) => source === 'devto' ? 'DEV.TO' : 'MEDIUM'

function visibleItems() {
  if (activeFilter === 'saved') return state.items.filter((item) => item.saved)
  if (activeFilter === 'ideas') return state.items.filter((item) => ideasByContent.has(item.id))
  return state.items
}

function selectedItem() {
  return state.items.find((item) => item.id === selectedId) ?? null
}

function renderCounts() {
  document.querySelector('#count-all')!.textContent = String(state.items.length)
  document.querySelector('#count-saved')!.textContent = String(state.items.filter((item) => item.saved).length)
  document.querySelector('#count-with-ideas')!.textContent = String(state.items.filter((item) => ideasByContent.has(item.id)).length)
  document.querySelector('#count-feed')!.textContent = String(state.items.length)
  const totalIdeas = [...ideasByContent.values()].reduce((sum, count) => sum + count, 0)
  document.querySelector('#count-ideas')!.textContent = totalIdeas ? String(totalIdeas) : ''
  navButtons.ideas.classList.toggle('generating', Boolean(generating))
}

function renderFeed() {
  renderCounts()
  const items = visibleItems()
  if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id ?? null
  if (!items.length) {
    const empty = activeFilter === 'saved' ? ['Nada salvo ainda.', 'Salve artigos para montar sua lista de leitura.'] : activeFilter === 'ideas' ? ['Nenhum artigo virou ideia ainda.', 'Abra um artigo e clique em Gerar ideia.'] : ['Vamos encontrar boas leituras.', 'Ajuste seus interesses e busque publicações recentes no Dev.to e no Medium.']
    feed.innerHTML = `<div class="feed-empty"><h3>${empty[0]}</h3><p>${empty[1]}</p>${activeFilter === 'all' ? '<button type="button" class="cta" data-action="refresh">Buscar primeiros artigos</button>' : ''}</div>`
    return
  }
  const shown = items.slice(0, visibleCount)
  feed.innerHTML = shown.map((item) => {
    const ideas = ideasByContent.get(item.id) ?? 0
    const chips = [...item.tags.slice(0, 2).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`),
      item.isExploratory ? '<span class="chip">Descoberta adjacente</span>' : '',
      ideas ? `<span class="chip chip-idea">${svg.idea}${ideas} ideia${ideas > 1 ? 's' : ''}</span>` : ''].join('')
    const progress = generating?.contentId === item.id ? `<div class="row-progress"><span class="spin" aria-hidden="true"></span><span>Gerando ideia…</span><button type="button" class="text-btn" data-action="cancel-generation">Cancelar</button></div>` : ''
    const meta = [escapeHtml(item.author), relativeDate(item.publishedAt), item.readingMinutes ? `${item.readingMinutes} min` : ''].filter(Boolean).join(' · ')
    return `<article class="feed-row ${item.id === selectedId ? 'selected' : ''}" data-id="${escapeHtml(item.id)}"><div class="feed-row-main"><div class="meta"><span class="src">${sourceLabel(item.source)}</span><span>${meta}</span></div><button type="button" class="feed-row-title" data-action="select" aria-pressed="${item.id === selectedId}">${escapeHtml(item.title)}</button>${chips ? `<div class="feed-row-chips">${chips}</div>` : ''}${progress}</div><div class="feed-row-score" title="Relevância">${Math.round(item.score)}</div></article>`
  }).join('')
  if (items.length > shown.length) feed.insertAdjacentHTML('beforeend', `<div class="feed-more"><button type="button" class="btn" data-action="show-more">Ver mais ${Math.min(20, items.length - shown.length)} de ${items.length - shown.length}</button></div>`)
}

function renderReading() {
  const item = selectedItem()
  if (!item) {
    readingPane.innerHTML = '<div class="reading-empty"><h2>Nada selecionado</h2><p>Escolha um artigo na lista para ler o resumo e transformá-lo em ideia de projeto.</p></div>'
    return
  }
  const meta = [escapeHtml(item.author), relativeDate(item.publishedAt), item.readingMinutes ? `${item.readingMinutes} min de leitura` : ''].filter(Boolean).join(' · ')
  const scoreEvidence = [
    item.personalUtility == null ? '' : `Utilidade pessoal ${Math.round(item.personalUtility * 100)}%`,
    item.topicFit == null ? '' : `Aderência temática ${Math.round(item.topicFit * 100)}%`,
    item.technicalSubstance == null ? '' : `Substância técnica ${Math.round(item.technicalSubstance * 100)}%`,
  ].filter(Boolean)
  const reasons = [...item.reasons.slice(0, 4), ...scoreEvidence].map((reason) => `<span class="chip">${escapeHtml(reason)}</span>`).join('')
  const analysis = item.summary || item.category || item.hypeEvidence.length
    ? `<div class="analysis"><strong>${escapeHtml(categoryLabel(item.category))}${item.hypeEvidence.length ? ` · sinais observáveis (${Math.round((item.hypeConfidence ?? 0) * 100)}% de evidência)` : ''}</strong>${item.summary ? `<span>${escapeHtml(item.summary)}</span>` : ''}${item.hypeEvidence.length ? `<span class="muted">${item.hypeEvidence.map(escapeHtml).join(' · ')}</span>` : ''}</div>` : ''
  const jev = item.jevAssessment ? `<div class="analysis"><strong>Jev · ${item.jevAssessment.status === 'partial' ? 'avaliação parcial' : 'avaliação válida'}</strong><span>Utilidade ${escapeHtml(item.jevAssessment.utility?.level ?? 'neutra')} · profundidade ${escapeHtml(item.jevAssessment.technicalDepth?.level ?? 'neutra')}</span></div>` : ''
  const ideas = ideasByContent.get(item.id) ?? 0
  const stats = contextSummary
    ? `<div class="project-stats"><span>${contextSummary.projects} projeto${contextSummary.projects === 1 ? '' : 's'} indexado${contextSummary.projects === 1 ? '' : 's'}</span><span>${contextSummary.memories} memória${contextSummary.memories === 1 ? '' : 's'}</span><span class="${contextSummary.isolation === 'ready' ? 'ok' : 'off'}">${contextSummary.isolation === 'ready' ? 'Leitura isolada ativa' : 'Projetos não consultados'}</span></div>` : ''
  const isGenerating = generating?.contentId === item.id
  readingPane.innerHTML = `
    <div class="meta"><span class="src">${sourceLabel(item.source)}</span><span>${meta}</span></div>
    <h2>${escapeHtml(item.title)}</h2>
    <p class="reading-text">${escapeHtml(item.description || 'Sem descrição disponível no feed. Leia no site para ver o conteúdo completo.')}</p>
    ${analysis}${jev}
    ${reasons ? `<div class="reading-block"><div class="label">Por que está aqui</div><div class="feed-row-chips">${reasons}</div></div>` : ''}
    <div class="reading-actions">
      <button type="button" class="icon-btn" data-action="save" aria-pressed="${item.saved}" aria-label="${item.saved ? 'Remover dos salvos' : 'Salvar para ler depois'}" title="${item.saved ? 'Remover dos salvos' : 'Salvar'}">${svg.save}</button>
      <button type="button" class="icon-btn" data-action="useful" aria-pressed="${item.rating === 'useful'}" aria-label="Útil" title="Útil">${svg.useful}</button>
      <button type="button" class="icon-btn" data-action="not_useful" aria-pressed="${item.rating === 'not_useful'}" aria-label="Não foi útil" title="Não foi útil">${svg.notUseful}</button>
      <button type="button" class="text-btn" data-action="analyze">${item.summary ? 'Atualizar resumo' : 'Resumir e classificar'}</button>
      <button type="button" class="text-btn" data-action="hide">Ocultar</button>
      <button type="button" class="btn push" data-action="open">Ler no site ${svg.external}</button>
    </div>
    <div class="project-card">
      <div><h3>E se isso virasse um projeto?</h3><p>O Loounp cruza o artigo com seus projetos e objetivos e propõe uma ideia com justificativa e stack. Você vê exatamente o que será enviado antes de gerar.</p></div>
      ${stats}
      <div class="project-card-actions">
        ${isGenerating ? '<div class="notice notice-info"><span class="spin" aria-hidden="true"></span><span>Gerando a ideia deste artigo. Você pode continuar lendo.</span></div>' : `<button type="button" class="cta" data-action="idea">Gerar ideia ${svg.arrow}</button>`}
        ${ideas ? `<button type="button" class="link-button" data-action="view-ideas">Ver ${ideas > 1 ? `as ${ideas} ideias` : 'a ideia'} deste artigo</button>` : ''}
      </div>
    </div>`
}

function render() {
  renderFeed()
  if (!isIdeaPanelOpen()) renderReading()
}

async function loadIdeaSummary() {
  const history = await window.projectIdeas.history().catch(() => [] as IdeaHistoryItem[])
  ideasByContent = new Map()
  for (const item of history) if (item.contentId) ideasByContent.set(item.contentId, (ideasByContent.get(item.contentId) ?? 0) + 1)
}

async function loadContextSummary() {
  const [status, memory] = await Promise.all([window.projectIdeas.contextStatus().catch(() => null), window.projectIdeas.listMemory().catch(() => null)])
  contextSummary = status ? {
    projects: status.projects.length,
    memories: memory ? memory.memories.filter((entry) => entry.confirmed && !entry.ignoredInIdeas).length : 0,
    isolation: status.isolation.state,
  } : null
}

async function showView(view: View, operationId?: string) {
  currentView = view
  for (const [name, button] of Object.entries(navButtons) as Array<[View, HTMLButtonElement]>) {
    button.classList.toggle('active', name === view)
    if (name === view) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  feedView.hidden = view !== 'feed'
  if (view === 'ideas') await showIdeasView(operationId)
  else hideIdeasView()
  if (view === 'context') await showContextView()
  else hideContextView()
  if (view === 'feed') render()
}

setIdeaPanelHandlers({
  onOpenIdea: (operationId) => void showView('ideas', operationId),
  onGenerationStarted: (operationId, contentId) => { generating = { operationId, contentId }; render() },
})
setIdeasViewHandlers({ reviewOperation: (operationId) => { void showView('feed').then(() => openIdeaPanelOperation(operationId)) }, feedTitle: (contentId) => state?.items.find((item) => item.id === contentId)?.title })
setContextViewHandlers({ onChanged: () => { void loadContextSummary().then(() => { if (currentView === 'feed') render() }) } })

window.projectIdeas.onEvent((event) => {
  handleIdeaEvent(event)
  if (event.type === 'state') {
    if (event.state === 'generating' || event.state === 'validating') generating = { operationId: event.operationId, contentId: event.contentId }
    if (currentView === 'feed') render()
    else renderCounts()
    return
  }
  if (generating?.operationId === event.operationId) generating = null
  void loadIdeaSummary().then(() => {
    if (currentView === 'feed') render()
    else renderCounts()
    void refreshIdeasView()
  })
  if (event.contextMode === 'article_only') {
    if (event.outcome !== 'canceled') notify('Versão sem contexto pronta. Compare as duas em Ideias.', undefined, event.comparisonOf ? { label: 'Comparar', run: () => void showView('ideas', event.comparisonOf!) } : undefined)
    return
  }
  if (event.outcome === 'recommendation') { notifyIdea(event.title, event.articleTitle, event.operationId); return }
  if (event.outcome === 'insufficient_context' || event.outcome === 'no_application' || event.outcome === 'failed') {
    notify(`${outcomeLabels[event.outcome]} · ${event.articleTitle}${event.outcome === 'failed' && event.error ? `: ${event.error}` : ''}`, undefined, { label: 'Ver em Ideias', run: () => void showView('ideas') })
  }
})

void window.projectIdeas.getStatus().then((current) => {
  if (!current) return
  if (current.operation.state === 'generating' || current.operation.state === 'validating') { generating = { operationId: current.operation.id, contentId: current.operation.contentId }; if (state) render() }
  const key = `loounp:interrupted:${current.operation.id}`
  let seen = false
  try { seen = localStorage.getItem(key) === '1' } catch { seen = false }
  if (current.operation.state === 'interrupted' && !seen) {
    notify(`A geração de "${current.operation.article?.title ?? 'um artigo'}" foi interrompida quando o app fechou; nada foi reenviado.`)
    try { localStorage.setItem(key, '1') } catch { seen = true }
  }
}).catch(() => undefined)

function renderDiscoveryDiagnostics() {
  const element = document.querySelector<HTMLDetailsElement>('#discovery-diagnostics')!
  const stats = state.discoveryStats
  if (!stats) { element.hidden = true; element.replaceChildren(); return }
  element.hidden = false
  element.innerHTML = `<summary>Última busca: ${stats.added} novos · ${stats.ranked} no feed${stats.errors ? ` · ${stats.errors} falha(s)` : ''}</summary><span>Recebidos: Dev.to ${stats.devtoFetched} · Medium ${stats.mediumFetched}; ${stats.uniqueFetched} únicos, ${stats.duplicatesRemoved} duplicatas.</span><span>${stats.awaitingAssessment} aguardam análise temática; ${stats.withoutTopicMatch} não casaram com os temas; ${stats.exploratory} entraram como descoberta adjacente; ${stats.jevZeroUtility} com utilidade Jev zero.</span>`
}

function addTopic(name = '', importance = 3, metadata?: InterestProfileV2['interestGroups'][number]) {
  const row = document.createElement('div')
  row.className = 'topic-row'
  if (metadata) topicMetadata.set(row, metadata)
  row.innerHTML = `<input type="text" maxlength="70" placeholder="Ex.: Agentes de IA" value="${escapeHtml(name)}"><input aria-label="Importância do tema" type="range" min="1" max="5" value="${importance}"><span class="topic-value">${importance}/5</span><button type="button" class="remove-topic" aria-label="Remover tema">×</button>`
  row.querySelector('input[type=range]')!.addEventListener('input', (event) => { row.querySelector('.topic-value')!.textContent = `${(event.target as HTMLInputElement).value}/5` })
  row.querySelector('.remove-topic')!.addEventListener('click', () => row.remove())
  document.querySelector('#topic-rows')!.append(row)
}

function showSettings() {
  onboardingShown = true
  document.querySelector('#topic-rows')!.innerHTML = ''
  const profile = isV2Profile(state.draftProfile) ? state.draftProfile : isV2Profile(state.profile) ? state.profile : null
  const legacyTopics = isV2Profile(state.profile) ? [] : state.profile.topics
  const groups = profile?.interestGroups ?? []
  if (profile) {
    ;(document.querySelector('#intent-text') as HTMLTextAreaElement).value = profile.intentText
    ;(document.querySelector('#positive-examples') as HTMLTextAreaElement).value = profile.examples.filter((example) => example.polarity === 'positive').map((example) => [example.url, [example.title, example.excerpt].filter(Boolean).join(' — ')].filter(Boolean).join(' — ')).join('\n')
    ;(document.querySelector('#negative-examples') as HTMLTextAreaElement).value = profile.examples.filter((example) => example.polarity === 'negative').map((example) => [example.url, [example.title, example.excerpt].filter(Boolean).join(' — ')].filter(Boolean).join(' — ')).join('\n')
    groups.forEach((group) => addTopic(group.label, group.priority, group))
  } else {
    ;(document.querySelector('#intent-text') as HTMLTextAreaElement).value = ''
    ;(document.querySelector('#positive-examples') as HTMLTextAreaElement).value = ''
    ;(document.querySelector('#negative-examples') as HTMLTextAreaElement).value = ''
    legacyTopics.forEach((topic) => addTopic(topic.name, topic.importance))
  }
  if (!groups.length && !legacyTopics.length) addTopic()
  ;(document.querySelector('#medium-feeds') as HTMLTextAreaElement).value = (profile?.mediumFeeds ?? (isV2Profile(state.profile) ? [] : state.profile.mediumFeeds)).join('\n')
  const slider = document.querySelector<HTMLInputElement>('#recency')!
  slider.value = String(Math.round((profile?.recencyPreference ?? (isV2Profile(state.profile) ? 0.55 : state.profile.recencyPreference)) * 100))
  document.querySelector('#recency-label')!.textContent = `${slider.value}% novidade`
  document.querySelector('#api-key')!.setAttribute('placeholder', state.hasApiKey ? 'Chave salva com segurança' : 'Chave de API (opcional)')
  document.querySelector('#jev-key')!.setAttribute('placeholder', state.hasJevKey ? 'Chave TypeSafe salva com segurança' : 'Chave API TypeSafe (acesso antecipado)')
  if (!dialog.open) dialog.showModal()
}

async function load() {
  state = await window.contentApp.getState()
  await Promise.all([loadIdeaSummary(), loadContextSummary()])
  document.querySelector('#ranking-status')!.textContent = state.rankingSource === 'jev' ? 'ranking Jev' : state.rankingSource === 'fallback' ? 'ranking base (Jev indisponível)' : 'ranking base'
  document.querySelector('#last-refresh')!.textContent = state.lastRefresh ? `Atualizado ${relativeDate(state.lastRefresh)}, ${new Date(state.lastRefresh).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Nenhuma busca ainda'
  if (currentView === 'feed') render()
  else renderCounts()
  renderDiscoveryDiagnostics()
  if (!onboardingShown && !isV2Profile(state.profile)) showSettings()
}

document.querySelector('#refresh')!.addEventListener('click', async () => {
  const button = document.querySelector<HTMLButtonElement>('#refresh')!
  const label = button.querySelector('span')!
  button.disabled = true
  visibleCount = 20
  label.textContent = 'Buscando…'
  try {
    const result = await window.contentApp.refresh()
    await load()
    notify(`${result.added} novos artigos encontrados${result.errors.length ? ` · ${result.errors.length} fonte(s) falharam` : ''}`)
    if (result.errors.length) console.warn('Falhas na ingestão:', result.errors)
  } catch (error) { notify(String(error)) }
  finally { button.disabled = false; label.textContent = 'Buscar novos' }
})

document.querySelector('#open-settings')!.addEventListener('click', showSettings)
document.querySelector('#brand')!.addEventListener('click', () => void showView('feed'))
navButtons.feed.addEventListener('click', () => void showView('feed'))
navButtons.ideas.addEventListener('click', () => void (currentView === 'ideas' ? refreshIdeasView() : showView('ideas')))
navButtons.context.addEventListener('click', () => void (currentView === 'context' ? refreshContextView() : showView('context')))
document.querySelector('#add-topic')!.addEventListener('click', () => addTopic())
document.querySelector('#recency')!.addEventListener('input', (event) => { document.querySelector('#recency-label')!.textContent = `${(event.target as HTMLInputElement).value}% novidade` })
document.querySelector('#settings-form')!.addEventListener('submit', async (event) => {
  if ((event as SubmitEvent).submitter && ((event as SubmitEvent).submitter as HTMLButtonElement).value !== 'save') return
  event.preventDefault()
  const rows = [...document.querySelectorAll<HTMLElement>('.topic-row')]
  const topics = rows.map((row) => ({ name: (row.querySelector('input[type=text]') as HTMLInputElement).value, importance: Number((row.querySelector('input[type=range]') as HTMLInputElement).value) })).filter((topic) => topic.name.trim())
  const mediumFeeds = (document.querySelector('#medium-feeds') as HTMLTextAreaElement).value.split(/\r?\n/).map((feed) => feed.trim()).filter(Boolean)
  try {
    const existing = isV2Profile(state.draftProfile) ? state.draftProfile : isV2Profile(state.profile) ? state.profile : null
    {
      const previousGroups = new Map((existing?.interestGroups ?? []).map((group) => [group.label.toLowerCase(), group]))
      const interestGroups = rows.flatMap((row) => {
        const input = topics.find((topic) => topic.name === (row.querySelector('input[type=text]') as HTMLInputElement).value)
        if (!input) return []
        const previous = topicMetadata.get(row) ?? previousGroups.get(input.name.toLowerCase())
        const id = previous?.id ?? `interest-${crypto.randomUUID().slice(0, 8)}`
        return [{ ...(previous ?? { summary: input.name, objectives: [input.name], subtopics: [input.name], retrievalTerms: { devtoTags: [], mediumTopics: [] } }), id, label: input.name, priority: input.importance }]
      })
      const parseExamples = (selector: string, polarity: 'positive' | 'negative') => (document.querySelector<HTMLTextAreaElement>(selector)!.value.match(/[^\r\n]+/g) ?? []).map((raw) => {
        const text = raw.trim()
        const url = text.match(/https:\/\/\S+/)?.[0]
        const detail = (url ? text.replace(url, '').trim().replace(/^—\s*/, '') : text).slice(0, 1500)
        const [title, ...excerpt] = detail.split(' — ')
        return { polarity, ...(url ? { url } : {}), title: title.trim() || url!, excerpt: excerpt.join(' — ').trim() }
      }).filter((example) => example.title || example.url).slice(0, 10)
      const examples = [...parseExamples('#positive-examples', 'positive'), ...parseExamples('#negative-examples', 'negative')]
      const base = existing ?? {
        schemaVersion: 2 as const, status: 'draft' as const, intentText: '', interestGroups: [], positiveTraits: [],
        deprioritizeTraits: [], examples: [], mediumFeeds, recencyPreference: 0.55, revision: 0,
      }
      await window.contentApp.confirmProfile({
        ...base, schemaVersion: 2, status: 'confirmed',
        intentText: (document.querySelector<HTMLTextAreaElement>('#intent-text')!.value.trim() || base.intentText || 'My selected interests'),
        interestGroups, examples: examples.length ? examples : base.examples, mediumFeeds,
        recencyPreference: Number((document.querySelector('#recency') as HTMLInputElement).value) / 100,
      })
    }
    dialog.close(); await load(); notify('Seus interesses foram atualizados.')
  } catch (error) { notify(String(error)) }
})

document.querySelector<HTMLButtonElement>('#propose-interests')!.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const status = document.querySelector<HTMLElement>('#proposal-status')!
  const splitExamples = (selector: string) => (document.querySelector<HTMLTextAreaElement>(selector)!.value.match(/[^\r\n]+/g) ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 10)
  button.disabled = true
  status.dataset.error = 'false'
  status.textContent = 'Preparando uma proposta revisável…'
  try {
    await window.contentApp.proposeProfile({
      intentText: document.querySelector<HTMLTextAreaElement>('#intent-text')!.value.trim(),
      positiveExamples: splitExamples('#positive-examples'),
      negativeExamples: splitExamples('#negative-examples'),
    })
    await load()
    showSettings()
    document.querySelector<HTMLElement>('#proposal-status')!.textContent = 'Proposta pronta. Revise os grupos e exemplos antes de salvar.'
  } catch (error) {
    status.dataset.error = 'true'
    status.textContent = String(error)
  } finally { button.disabled = false }
})
document.querySelector('#save-key')!.addEventListener('click', async () => {
  const input = document.querySelector<HTMLInputElement>('#api-key')!
  if (!input.value.trim()) return notify('Informe uma chave de API.')
  try { await window.contentApp.setApiKey(input.value); input.value = ''; await load(); showSettings(); notify('Chave salva com criptografia do sistema.') }
  catch (error) { notify(String(error)) }
})
document.querySelector('#remove-key')!.addEventListener('click', async () => { await window.contentApp.clearApiKey(); await load(); showSettings(); notify('Chave removida.') })
document.querySelector('#save-jev-key')!.addEventListener('click', async () => {
  const input = document.querySelector<HTMLInputElement>('#jev-key')!
  if (!input.value.trim()) return notify('Informe uma chave Jev.')
  try { await window.contentApp.setJevKey(input.value); input.value = ''; await load(); showSettings(); notify('Chave TypeSafe salva com criptografia do sistema.') }
  catch (error) { notify(String(error)) }
})
document.querySelector('#remove-jev-key')!.addEventListener('click', async () => { await window.contentApp.clearJevKey(); await load(); showSettings(); notify('Chave Jev removida.') })

let mediumArchiveReady = false
document.querySelector<HTMLButtonElement>('#preview-medium-archive')!.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const preview = document.querySelector<HTMLElement>('#medium-archive-preview')!
  const confirm = document.querySelector<HTMLButtonElement>('#confirm-medium-archive')!
  button.disabled = true
  preview.hidden = false
  preview.textContent = 'Lendo apenas bookmarks, claps e listas pessoais…'
  confirm.disabled = true
  mediumArchiveReady = false
  try {
    const result = await window.contentApp.previewMediumArchive()
    if (!result) { preview.hidden = true; return }
    preview.replaceChildren()
    const summary = document.createElement('div')
    summary.textContent = `${result.uniqueArticles} artigos únicos · ${result.bookmarks} salvos · ${result.claps} com clap · ${result.listItems} em listas (${result.total} registros antes de remover duplicatas).`
    const list = document.createElement('ul')
    list.className = 'archive-samples'
    for (const item of result.samples) {
      const row = document.createElement('li')
      row.textContent = `${item.title} — ${item.signals.join(', ')}`
      list.append(row)
    }
    preview.append(summary, list)
    mediumArchiveReady = result.uniqueArticles > 0
    confirm.disabled = !mediumArchiveReady
  } catch (error) { preview.textContent = String(error) }
  finally { button.disabled = false }
})
document.querySelector<HTMLButtonElement>('#confirm-medium-archive')!.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement
  if (!mediumArchiveReady) return
  button.disabled = true
  try {
    const result = await window.contentApp.importMediumArchive()
    mediumArchiveReady = false
    document.querySelector<HTMLElement>('#medium-archive-preview')!.hidden = true
    await load()
    showSettings()
    notify(`${result.imported} artigos importados; ${result.learnedFrom} sinais de preferência adicionados. Faça uma nova busca para usar os exemplos na descoberta.`)
  } catch (error) { notify(String(error)) }
  finally { button.disabled = true }
})

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => button.addEventListener('click', () => {
  activeFilter = (button.dataset.filter as Filter | undefined) ?? 'all'
  visibleCount = 20
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab === button)
    tab.setAttribute('aria-selected', String(tab === button))
  })
  render()
}))

feed.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'refresh') { document.querySelector<HTMLButtonElement>('#refresh')!.click(); return }
  if (action === 'show-more') { visibleCount += 20; render(); return }
  if (action === 'cancel-generation' && generating) {
    try { await window.projectIdeas.cancel(generating.operationId) } catch (error) { notify(String(error)) }
    return
  }
  const row = target.closest<HTMLElement>('.feed-row')
  if (!row?.dataset.id) return
  selectedId = row.dataset.id
  if (isIdeaPanelOpen()) closeIdeaPanel()
  render()
})

readingPane.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  const item = selectedItem()
  if (!target || !item) return
  const action = target.dataset.action!
  if (action === 'idea') { void openIdeaPanel({ id: item.id, title: item.title, url: item.url }); return }
  if (action === 'view-ideas') {
    const history = await window.projectIdeas.history()
    void showView('ideas', history.find((entry) => entry.contentId === item.id)?.operationId)
    return
  }
  if (action === 'analyze' && !state.hasApiKey) { showSettings(); notify('Adicione uma chave OpenAI para usar o resumo.'); return }
  try {
    if (action === 'open') { await window.contentApp.recordFeedback(item.id, 'open'); await window.contentApp.openLink(item.url) }
    if (action === 'save') await window.contentApp.recordFeedback(item.id, item.saved ? 'unsave' : 'save')
    if (action === 'useful' || action === 'not_useful') await window.contentApp.recordFeedback(item.id, 'rate', action)
    if (action === 'hide') await window.contentApp.recordFeedback(item.id, 'hide')
    if (action === 'analyze') { target.textContent = 'Resumindo…'; await window.contentApp.analyze(item.id) }
    await load()
    if (action === 'analyze') notify('Resumo e sinais editoriais atualizados.')
    if (action === 'useful') notify('Anotado: a avaliação afeta o ranking e as próximas buscas.')
    if (action === 'not_useful') notify('Anotado: essa avaliação reduz a prioridade do tema correspondente.')
    if (action === 'hide') notify('Artigo ocultado do feed.', item.id)
  } catch (error) { notify(String(error)); await load() }
})

void load()
