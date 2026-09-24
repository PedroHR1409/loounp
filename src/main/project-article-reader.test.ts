import { describe, expect, it } from 'vitest'
import { ArticleFetchError, extractArticle, fetchPublicDocument, isPublicAddress, readArticle, snapshotFromHtml, snapshotFromUserText, type ArticleReaderDeps, type TransportResponse } from './project-article-reader'

const now = new Date('2026-09-23T12:00:00Z')

function response(status: number, body = '', headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: (async function* () { if (body) yield Buffer.from(body) })(), abort: () => undefined }
}

function deps(routes: Record<string, TransportResponse>, dns: Record<string, string[]> = {}): ArticleReaderDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolve: async (hostname) => (dns[hostname] ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    transport: async (url, address) => { calls.push(`${url.toString()}@${address.address}`); return routes[url.toString()] ?? response(404) },
    now: () => now,
  }
}

const longArticle = `<html><head><title>Busca híbrida</title><meta property="og:description" content="Resumo"></head><body><nav>menu</nav><article><h1>Busca híbrida</h1>${'<p>BM25 e grafos para localizar componentes em repositórios.</p>'.repeat(20)}<script>alert(1)</script></article></body></html>`

describe('address validation', () => {
  it('blocks private, loopback, link-local, multicast, reserved and IPv4 embedded in IPv6', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', '::127.0.0.1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true)
  })
})

describe('public document fetch', () => {
  it('connects to the validated address and extracts the main text', async () => {
    const d = deps({ 'https://example.com/post': response(200, longArticle) })
    const article = await readArticle('https://example.com/post', { kind: 'url', url: 'https://example.com/post' }, d)
    expect(d.calls).toEqual(['https://example.com/post@93.184.216.34'])
    expect(article.coverage).toBe('main_text')
    expect(article.text).not.toContain('alert(1)')
    expect(article.text).not.toContain('menu')
    expect(article.limitations[0]).toContain('completude')
  })

  it('rejects hosts that resolve to any private address (DNS rebinding) and credentialed URLs', async () => {
    await expect(fetchPublicDocument('https://evil.test/', deps({}, { 'evil.test': ['93.184.216.34', '127.0.0.1'] }))).rejects.toThrow('privado')
    await expect(fetchPublicDocument('https://user:pw@example.com/', deps({}))).rejects.toThrow('credenciais')
    await expect(fetchPublicDocument('http://localhost/', deps({}))).rejects.toThrow(ArticleFetchError)
    await expect(fetchPublicDocument('file:///C:/x', deps({}))).rejects.toThrow('HTTP')
    await expect(fetchPublicDocument('https://example.com:8443/', deps({}))).rejects.toThrow('Porta')
  })

  it('revalidates each redirect and stops after three', async () => {
    const toPrivate = deps({ 'https://example.com/a': response(302, '', { location: 'http://169.254.169.254/latest' }) })
    await expect(fetchPublicDocument('https://example.com/a', toPrivate)).rejects.toThrow('privado')
    const loop = deps({
      'https://example.com/1': response(301, '', { location: '/2' }), 'https://example.com/2': response(301, '', { location: '/3' }),
      'https://example.com/3': response(301, '', { location: '/4' }), 'https://example.com/4': response(301, '', { location: '/5' }),
    })
    await expect(fetchPublicDocument('https://example.com/1', loop)).rejects.toThrow('Redirecionamentos')
  })

  it('enforces the response size limit and content type', async () => {
    await expect(fetchPublicDocument('https://example.com/big', deps({ 'https://example.com/big': response(200, 'x'.repeat(6 * 1024 * 1024)) }))).rejects.toThrow('5 MiB')
    await expect(fetchPublicDocument('https://example.com/pdf', deps({ 'https://example.com/pdf': response(200, '%PDF', { 'content-type': 'application/pdf' }) }))).rejects.toThrow('texto')
  })
})

describe('coverage labels (AT-03)', () => {
  it('labels paywalled pages as partial and empty pages as metadata only', () => {
    const paywalled = snapshotFromHtml(longArticle.replace('<article>', '<article><p>Member-only story</p>'), { kind: 'url', url: 'https://medium.com/x' }, now)
    expect(paywalled.coverage).toBe('partial')
    const empty = snapshotFromHtml('<html><head><title>Só título</title><meta name="description" content="Descrição pública"></head><body></body></html>', { kind: 'url', url: 'https://x.test' }, now)
    expect(empty.coverage).toBe('metadata_only')
    expect(empty.text).toBe('Só título\n\nDescrição pública')
    const truncated = snapshotFromHtml(`<article>${'<p>palavra </p>'.repeat(12000)}</article>`, { kind: 'text' }, now)
    expect(truncated.coverage).toBe('partial')
    expect(truncated.text.length).toBe(80_000)
  })

  it('manual text is user_text and never claims full-page access', () => {
    const manual = snapshotFromUserText('conteúdo colado '.repeat(30), 'Título', { kind: 'item', contentId: 'medium:1' }, now)
    expect(manual.coverage).toBe('user_text')
    expect(manual.limitations[0]).toContain('não comprova acesso')
  })

  it('decodes entities and keeps headings', () => {
    expect(extractArticle('<article><h2>Parte &amp; todo</h2><p>a&#233;b</p></article>').text).toBe('## Parte & todo\naéb')
  })
})
