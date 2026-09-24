export const purposeLabels: Record<IdeaPurpose, string> = { both: 'Portfólio e uso prático', practical: 'Uso prático em projetos', portfolio: 'Portfólio e aprendizado' }
export const purposes: IdeaPurpose[] = ['both', 'practical', 'portfolio']
export const coverageLabels: Record<string, string> = { main_text: 'texto completo', user_text: 'texto colado por você', partial: 'captura parcial', metadata_only: 'só título e descrição' }
export const kindLabels: Record<string, string> = { goal: 'Objetivo', preference: 'Preferência', experience: 'Experiência', constraint: 'Restrição', project_context: 'Contexto de projeto', knowledge: 'Conhecimento' }
export const statusLabels: Record<string, string> = { recommendation: 'Ideia', insufficient_context: 'Contexto insuficiente', no_application: 'Nenhuma aplicação convincente' }
export const outcomeLabels: Record<IdeaOutcome, string> = {
  recommendation: 'Ideia pronta', insufficient_context: 'Contexto insuficiente para uma ideia', no_application: 'Nenhuma aplicação convincente',
  failed: 'A geração falhou', canceled: 'Geração cancelada', interrupted: 'Geração interrompida',
}

export const icons = {
  close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
  smallClose: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>',
  file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6v18h12V7z"></path><path d="M14 3v4h4"></path></svg>',
  star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="FILL" stroke="STROKE" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"></path></svg>',
  refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"></path></svg>',
  arrow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>',
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: { className?: string; text?: string; html?: string; attrs?: Record<string, string> } = {}, ...children: Array<Node | string | null | false | undefined>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.html !== undefined) node.innerHTML = options.html
  if (options.text !== undefined) node.textContent = options.text
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value)
  for (const child of children) if (child) node.append(child)
  return node
}

export function button(label: string, onClick: () => void, className = 'btn', disabled = false) {
  const node = el('button', { className, text: label, attrs: { type: 'button' } })
  node.disabled = disabled
  node.addEventListener('click', onClick)
  return node
}

export function iconButton(icon: string, label: string, onClick: () => void, className = 'remove-x', disabled = false) {
  const node = el('button', { className, html: icon, attrs: { type: 'button', 'aria-label': label, title: label } })
  node.disabled = disabled
  node.addEventListener('click', onClick)
  return node
}

export function errorText(error: unknown) {
  return String((error as Error)?.message ?? error).replace(/^Error: (Error invoking remote method '[^']+': )?(Error: |ConsentError: |ContractError: )?/, '')
}

export function toast(message: string, action?: { label: string; run: () => void }) {
  window.dispatchEvent(new CustomEvent('loounp:toast', { detail: { message, action } }))
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function shortDate(value: string) {
  return new Date(value).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
}

export function evidenceShortLabel(label: string) {
  if (label.startsWith('Artigo')) return 'artigo'
  if (label.startsWith('Contexto pessoal')) return 'memória'
  const path = label.split(' · ')[1] ?? label
  return path.replace(/ L\d+-\d+.*$/, '').split('/').pop() ?? path
}
