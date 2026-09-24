import { describe, expect, it } from 'vitest'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { SandboxSupervisor, checkIsolation, type SandboxEnvironment } from '../../src/main/project-context-sandbox'
import { ProjectContextStore, DEFAULT_PROTECTED_ROOT } from '../../src/main/project-context-store'
import { ingestCatalog, retrieveEvidence, type ProjectIndex } from '../../src/main/project-context-retrieval'
import { fixtureFiles } from './fixtures'

type Case = { id: string; kind: 'relational' | 'negative_control'; title: string; article: string; lexicalEntry: string | null; target: string | null }

const featureRoot = join(process.env.APPDATA!, 'content-discovery-poc', 'article-to-project')

async function catalog(env: SandboxEnvironment, graph: boolean, userData: string) {
  const store = await ProjectContextStore.open({ baseDirectory: userData, protectedRoot: DEFAULT_PROTECTED_ROOT })
  const started = performance.now()
  const result = await new SandboxSupervisor(env).run('catalog', { graph })
  const catalogMs = performance.now() - started
  const coverage = await ingestCatalog(store, result.response, result.projectFiles, new Date())
  return { store, catalogMs, coverage }
}

describe('Gate 2 — lexical vs lexical + graph', () => {
  it('runs the pre-registered cases through the real isolated pipeline', async () => {
    const cases = JSON.parse(await readFile(join(__dirname, 'cases.json'), 'utf8')).cases as Case[]
    const base = await mkdtemp(join(tmpdir(), 'a2p-gate2-'))
    try {
      const source = join(base, 'fixture')
      for (const [path, content] of Object.entries(fixtureFiles)) {
        await mkdir(dirname(join(source, path)), { recursive: true })
        await writeFile(join(source, path), content)
      }
      const feature = join(base, 'feature')
      await mkdir(feature)
      await copyFile(join(featureRoot, 'gate-approval.json'), join(feature, 'gate-approval.json'))
      const env: SandboxEnvironment = {
        platform: process.platform, runtimeDirectory: join(featureRoot, 'runtime'), featureDirectory: feature,
        lowDirectory: join(process.env.USERPROFILE!, 'AppData', 'LocalLow', 'content-discovery-poc', 'article-to-project', 'gate2'),
        sourceRoot: source, protectedRoot: DEFAULT_PROTECTED_ROOT, realSourcesEnabled: () => true,
      }
      const isolation = await checkIsolation(env)
      expect(isolation.state, isolation.reasons.join(' ')).toBe('ready')

      const withGraph = await catalog(env, true, join(base, 'with-graph'))
      const withoutGraph = await catalog(env, false, join(base, 'without-graph'))
      const indexes = (await Promise.all(withGraph.store.list('projects').map((project) => withGraph.store.readIndex<ProjectIndex>(project.id)))).filter((index): index is ProjectIndex => Boolean(index))
      const graphStats = indexes.map((index) => {
        const nodeFile = new Map(index.graph.nodes.map((node) => [node.id, node.relativePath]))
        const crossFile = index.graph.edges.filter((edge) => nodeFile.get(edge.source) && nodeFile.get(edge.target) && nodeFile.get(edge.source) !== nodeFile.get(edge.target))
        return { project: withGraph.store.get('projects', index.projectId)?.label, nodesDetail: index.graph.nodes.map((node) => `${node.id.slice(0, 8)} ${node.label} @ ${node.relativePath}`), edgesDetail: index.graph.edges.map((edge) => `${edge.source.slice(0, 8)} -${edge.relation}-> ${edge.target.slice(0, 8)}`), status: index.graph.status, nodes: index.graph.nodes.length, edges: index.graph.edges.length, crossFileEdges: crossFile.length, crossFileRelations: [...new Set(crossFile.map((edge) => edge.relation))] }
      })

      const results = []
      for (const testCase of cases) {
        const article = { title: testCase.title, text: testCase.article }
        const timed = async (graph: boolean) => {
          const started = performance.now()
          const result = await retrieveEvidence(withGraph.store, article, undefined, { graph })
          return { ms: performance.now() - started, evidence: result.evidence, candidateFiles: result.candidateFiles, neighborFiles: result.neighborFiles }
        }
        const lexical = await timed(false)
        const hybrid = await timed(true)
        const invalid = hybrid.evidence.filter((item) => !withGraph.store.get('source_versions', item.sourceVersionId) || !existsSync(join(source, item.relativePath))
          || item.graphRelations.some((relation) => relation.split(': ')[1].split(' → ').some((path) => !existsSync(join(source, path)))))
        const files = (evidence: typeof lexical.evidence) => [...new Set(evidence.map((item) => item.relativePath))]
        const inLexical = testCase.target ? files(lexical.evidence).includes(testCase.target) : null
        const inHybrid = testCase.target ? files(hybrid.evidence).includes(testCase.target) : null
        results.push({
          id: testCase.id, kind: testCase.kind, target: testCase.target,
          entryFoundLexically: testCase.lexicalEntry ? files(lexical.evidence).includes(testCase.lexicalEntry) : null,
          targetLexical: inLexical, targetHybrid: inHybrid, improvement: testCase.kind === 'relational' ? Boolean(inHybrid && !inLexical) : null,
          lexicalFiles: files(lexical.evidence), hybridOnlyFiles: files(hybrid.evidence).filter((path) => !files(lexical.evidence).includes(path)),
          inferredEvidence: hybrid.evidence.filter((item) => item.origin === 'inferred').map((item) => ({ file: item.relativePath, relation: item.graphRelations[0] })),
          candidateFiles: hybrid.candidateFiles, neighborFiles: hybrid.neighborFiles, invalidReferences: invalid.length, retrievalMs: { lexical: Math.round(lexical.ms), hybrid: Math.round(hybrid.ms) },
        })
      }
      const improvements = results.filter((result) => result.improvement).length
      const negative = results.find((result) => result.kind === 'negative_control')!
      const verdict = {
        improvements, invalidReferences: results.reduce((sum, result) => sum + result.invalidReferences, 0),
        negativeControlGraphAdditions: negative.inferredEvidence.length,
        pass: improvements >= 3 && results.every((result) => result.invalidReferences === 0) && negative.inferredEvidence.length === 0,
      }
      const report = {
        ranAt: new Date().toISOString(), pipeline: 'supervisor → lowil_launcher (integridade baixa + Job Object) → worker → graphify 0.9.66',
        catalogMs: { withGraph: Math.round(withGraph.catalogMs), withoutGraph: Math.round(withoutGraph.catalogMs) },
        coverage: { withGraph: withGraph.coverage, withoutGraph: withoutGraph.coverage }, graphStats, results, verdict,
      }
      await writeFile(join(__dirname, 'results.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ catalogMs: report.catalogMs, graphStats, results: results.map(({ id, entryFoundLexically, targetLexical, targetHybrid, improvement, hybridOnlyFiles, inferredEvidence, invalidReferences }) => ({ id, entryFoundLexically, targetLexical, targetHybrid, improvement, hybridOnlyFiles, inferred: inferredEvidence.length, invalidReferences })), verdict }, null, 2))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }, 600_000)
})
