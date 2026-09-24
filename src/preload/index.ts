import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('contentApp', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveProfile: (profile: unknown) => ipcRenderer.invoke('profile:save', profile),
  proposeProfile: (input: unknown) => ipcRenderer.invoke('discovery:propose-profile', input),
  confirmProfile: (profile: unknown) => ipcRenderer.invoke('profile:confirm', profile),
  refresh: () => ipcRenderer.invoke('feed:refresh'),
  recordFeedback: (contentId: string, action: string, value?: string) =>
    ipcRenderer.invoke('feedback:record', { contentId, action, value }),
  openLink: (url: string) => ipcRenderer.invoke('link:open', url),
  analyze: (contentId: string) => ipcRenderer.invoke('content:analyze', contentId),
  setApiKey: (apiKey: string) => ipcRenderer.invoke('settings:set-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-api-key'),
  setJevKey: (apiKey: string) => ipcRenderer.invoke('settings:set-jev-key', apiKey),
  clearJevKey: () => ipcRenderer.invoke('settings:clear-jev-key'),
  previewMediumArchive: () => ipcRenderer.invoke('medium-archive:preview'),
  importMediumArchive: () => ipcRenderer.invoke('medium-archive:commit'),
})

contextBridge.exposeInMainWorld('projectIdeas', {
  start: (input: unknown) => ipcRenderer.invoke('project-ideas:start', input),
  submitText: (input: unknown) => ipcRenderer.invoke('project-ideas:submit-text', input),
  getStatus: () => ipcRenderer.invoke('project-ideas:get-status'),
  cancel: (operationId: string) => ipcRenderer.invoke('project-ideas:cancel', { operationId }),
  removeItem: (input: unknown) => ipcRenderer.invoke('project-ideas:remove-item', input),
  setPurpose: (input: unknown) => ipcRenderer.invoke('project-ideas:set-purpose', input),
  rebuild: (operationId: string) => ipcRenderer.invoke('project-ideas:rebuild', { operationId }),
  view: (operationId: string) => ipcRenderer.invoke('project-ideas:view', { operationId }),
  history: (purpose?: string) => ipcRenderer.invoke('project-ideas:history', purpose ? { purpose } : {}),
  deleteIdea: (operationId: string) => ipcRenderer.invoke('project-ideas:delete', { operationId }),
  ignored: () => ipcRenderer.invoke('project-context:ignored'),
  unignore: (id: string) => ipcRenderer.invoke('project-context:unignore', { id }),
  setMemoryIgnored: (memoryId: string, ignored: boolean) => ipcRenderer.invoke('personal-memory:set-ignored', { memoryId, ignored }),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('project-ideas:event', listener)
    return () => { ipcRenderer.removeListener('project-ideas:event', listener) }
  },
  authorize: (input: unknown) => ipcRenderer.invoke('project-ideas:authorize', input),
  deny: (operationId: string) => ipcRenderer.invoke('project-ideas:deny', { operationId }),
  rate: (input: unknown) => ipcRenderer.invoke('project-ideas:rate', input),
  setModel: (input: unknown) => ipcRenderer.invoke('project-ideas:set-model', input),
  startComparison: (operationId: string) => ipcRenderer.invoke('project-ideas:compare-start', { operationId }),
  comparison: (operationId: string) => ipcRenderer.invoke('project-ideas:comparison', { operationId }),
  recordPreference: (evaluationId: string, choice: 'A' | 'B' | 'tie') => ipcRenderer.invoke('project-ideas:compare-record', { evaluationId, choice }),
  refreshContext: (input: unknown) => ipcRenderer.invoke('project-context:refresh', input),
  contextStatus: () => ipcRenderer.invoke('project-context:status'),
  readEvidence: (operationId: string, itemId: string) => ipcRenderer.invoke('project-context:read-evidence', { operationId, itemId }),
  removeProjectContext: (projectId: string) => ipcRenderer.invoke('project-context:remove', { projectId }),
  setRealSources: (enabled: boolean) => ipcRenderer.invoke('project-context:set-real-sources', { enabled }),
  listMemory: () => ipcRenderer.invoke('personal-memory:list'),
  answerKnowledge: (term: string, known: boolean) => ipcRenderer.invoke('personal-memory:answer-knowledge', { term, known }),
  proposeMemory: (input: unknown) => ipcRenderer.invoke('personal-memory:propose', input),
  confirmMemory: (input: unknown) => ipcRenderer.invoke('personal-memory:confirm', input),
  correctMemory: (input: unknown) => ipcRenderer.invoke('personal-memory:correct', input),
  discardMemory: (input: unknown) => ipcRenderer.invoke('personal-memory:discard', input),
  revokeMemory: (input: unknown) => ipcRenderer.invoke('personal-memory:revoke', input),
  forgetMemory: (memoryId: string) => ipcRenderer.invoke('personal-memory:forget', { memoryId }),
})
