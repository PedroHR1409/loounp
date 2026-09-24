import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchDevto, fetchMedium, withBehavioralExamples, type ConfirmedInterestProfile } from './sources'

afterEach(() => vi.unstubAllGlobals())

describe('source connectors', () => {
  it('maps legacy topics to Dev.to tags and deduplicates normalized articles', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([{
      id: 42,
      title: 'Building AI agents',
      url: 'https://dev.to/example/building-ai-agents?utm_source=feed',
      canonical_url: 'https://dev.to/example/building-ai-agents?utm_source=feed',
      user: { name: 'Example Author' },
      published_at: '2026-09-19T12:00:00Z',
      description: 'A technical guide to agents.',
      tag_list: ['ai', 'agents']
    }]), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const articles = await fetchDevto(['Artificial Intelligence'])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('tag')).toBe('ai')
    expect(articles).toHaveLength(1)
    expect(articles[0].sourceOccurrences[0].source).toBe('devto')
    expect(articles[0].canonicalUrl).toBe('https://dev.to/example/building-ai-agents')
  })

  it('derives normalized Dev.to tags only from a confirmed profile and tolerates a failed tag', async () => {
    const profile: ConfirmedInterestProfile = {
      status: 'confirmed',
      retrievalTerms: { devtoTags: ['Data Engineering', 'dataengineering'] },
      interestGroups: [{ subtopics: ['Fabric'], retrievalTerms: { devtoTags: ['data-engineering'] } }]
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const tag = new URL(String(input)).searchParams.get('tag')
      if (tag === 'fabric') return new Response('unavailable', { status: 503 })
      return new Response(JSON.stringify([{
        id: 7, title: 'Data pipelines', url: 'https://dev.to/a/pipelines', canonical_url: 'https://dev.to/a/pipelines',
        tag_list: ['dataengineering']
      }]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const articles = await fetchDevto(profile)
    const queriedTags = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('tag'))

    expect(queriedTags).toEqual(['dataengineering', 'fabric'])
    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('Data pipelines')
  })

  it('uses positive example titles as a small adjacent discovery lane, not negative examples', async () => {
    const profile: ConfirmedInterestProfile = {
      status: 'confirmed',
      retrievalTerms: { devtoTags: ['dataengineering', 'fabric'] },
      interestGroups: [],
      examples: [
        { polarity: 'positive', title: 'Building an AI agent harness with Scala Spark' },
        { polarity: 'negative', title: 'Claude hype roundup' },
      ],
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchDevto(profile)
    const queriedTags = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('tag'))

    expect(queriedTags).toEqual(['dataengineering', 'fabric', 'ai', 'agent', 'harness', 'scala'])
  })

  it('puts recent explicit useful ratings ahead of broad imported history for retrieval expansion', () => {
    const profile: ConfirmedInterestProfile = {
      status: 'confirmed', interestGroups: [],
      examples: [{ polarity: 'negative', title: 'Hype list' }, { polarity: 'positive', title: 'Manual example' }, { polarity: 'positive', title: 'Rated not useful one' }],
    }
    const expanded = withBehavioralExamples(profile,
      ['Rated useful one', 'Rated useful two', 'Rated useful three', 'Rated useful four'],
      ['Rated not useful one'], ['Clapped archive article', 'Saved archive article'])

    expect(expanded.examples?.slice(0, 3).map(example => example.title)).toEqual(['Rated useful one', 'Rated useful two', 'Rated useful three'])
    expect(expanded.examples?.some(example => example.title === 'Hype list' && example.polarity === 'negative')).toBe(true)
    expect(expanded.examples?.some(example => example.title === 'Rated useful four')).toBe(false)
    expect(expanded.examples?.find(example => example.title === 'Rated not useful one')?.polarity).toBe('negative')
  })

  it('suppresses terms repeated in negative examples while preserving declared topic queries', async () => {
    const profile: ConfirmedInterestProfile = {
      status: 'confirmed', retrievalTerms: { devtoTags: ['claude'] }, interestGroups: [],
      examples: [
        { polarity: 'positive', title: 'Claude code architecture graphify' },
        { polarity: 'negative', title: 'Claude code marketing hype' },
      ],
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchDevto(profile)
    const queriedTags = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('tag'))

    expect(queriedTags).toEqual(['claude', 'architecture', 'graphify'])
    expect(queriedTags).not.toContain('code')
  })

  it('does not use draft profile terms', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchDevto({ status: 'draft', interestGroups: [{ subtopics: ['AI'] }] } as unknown as ConfirmedInterestProfile)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads Medium RSS metadata and keeps the article as a normalized occurrence', async () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>Practical LLM systems</title><link>https://medium.com/@author/practical-llm-systems?source=rss</link><description><![CDATA[<p>A field guide to building reliable systems.</p>]]></description><category>llm</category><dc:creator>Example Writer</dc:creator><pubDate>Sat, 19 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(xml, { status: 200 })))

    const articles = await fetchMedium(['https://medium.com/feed/tag/llm'])

    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('Practical LLM systems')
    expect(articles[0].author).toBe('Example Writer')
    expect(articles[0].canonicalUrl).toBe('https://medium.com/@author/practical-llm-systems')
    expect(articles[0].tags).toContain('llm')
  })

  it('adds deduplicated Medium topic RSS feeds from confirmed profile while preserving configured feeds', async () => {
    const profile: ConfirmedInterestProfile = {
      status: 'confirmed',
      interestGroups: [{ subtopics: ['Data Engineering'], retrievalTerms: { mediumTopics: ['ai-agents'] } }]
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('<rss><channel></channel></rss>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMedium(['https://medium.com/feed/tag/data-engineering'], profile)
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url))

    expect(requestedUrls).toEqual([
      'https://medium.com/feed/tag/data-engineering',
      'https://medium.com/feed/tag/ai-agents'
    ])
  })

  it('keeps successful Medium feeds when another configured feed fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/broken')) return new Response('unavailable', { status: 503 })
      return new Response('<rss><channel><item><title>Successful</title><link>https://medium.com/@a/story</link></item></channel></rss>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const articles = await fetchMedium(['https://medium.com/feed/tag/good', 'https://medium.com/broken'])

    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('Successful')
  })

  it('rejects a non-Medium RSS URL before requesting it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchMedium(['https://example.com/rss.xml'])).rejects.toThrow('Feed Medium inválido')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('follows a bounded redirect only when it stays on Medium', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/start')
      ? new Response(null, { status: 302, headers: { location: '/feed/tag/agents' } })
      : new Response('<rss><channel></channel></rss>', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMedium(['https://medium.com/start'])).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects external RSS redirects and oversized feed bodies', async () => {
    const externalRedirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/feed.xml' } }))
    vi.stubGlobal('fetch', externalRedirect)
    await expect(fetchMedium(['https://medium.com/feed/tag/ai'])).rejects.toThrow('host não permitido')
    expect(externalRedirect).toHaveBeenCalledTimes(1)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 })))
    await expect(fetchMedium(['https://medium.com/feed/tag/ai'])).rejects.toThrow('excede 2 MiB')
  })
})
