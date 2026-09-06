/**
 * DeepWiki client tests.
 *
 * The parsing here is the load-bearing part: the hosted service reports a
 * repository it has never indexed as *successful* tool content with a 200
 * status, not as an error. Reading that as success would have the agent tell
 * a student "DeepWiki says: Repository not found. Visit deepwiki.com to index
 * it." as though it were an answer about their code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { askRepo, normalizeRepoName, repoTopics } from './deepwiki';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.DEEPWIKI_DISABLED;
});

/** Builds an SSE response shaped like the hosted MCP endpoint's. */
function sseResponse(payload: unknown, status = 200): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function toolContent(text: string) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
}

describe('normalizeRepoName', () => {
  it('accepts a plain owner/repo', () => {
    expect(normalizeRepoName('facebook/react')).toBe('facebook/react');
  });

  it('accepts what a student would actually paste', () => {
    for (const input of [
      'https://github.com/facebook/react',
      'https://github.com/facebook/react/',
      'https://github.com/facebook/react.git',
      'https://github.com/facebook/react/tree/main/packages',
      'https://www.github.com/facebook/react/issues/123',
      '  facebook/react  ',
    ]) {
      expect(normalizeRepoName(input)).toBe('facebook/react');
    }
  });

  it('rejects hosts that are not github.com', () => {
    // Otherwise the repo name becomes a way to point us at another service.
    expect(normalizeRepoName('https://evil.example/facebook/react')).toBeNull();
    expect(normalizeRepoName('https://github.com.evil.example/a/b')).toBeNull();
  });

  it('rejects anything that is not a two-segment name', () => {
    for (const bad of ['react', 'a/b/c/d/e', '', '/', 'a/', '/b', null, 42, {}]) {
      expect(normalizeRepoName(bad as unknown)).toBeNull();
    }
  });

  it('rejects characters that could reshape the request', () => {
    for (const bad of ['owner/repo"', "owner/re'po", 'owner/re\npo', 'ow ner/repo', 'owner/re$po']) {
      expect(normalizeRepoName(bad)).toBeNull();
    }
  });

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(normalizeRepoName('facebook/react\n')).toBe('facebook/react');
  });

  it('only truncates extra path segments for real github.com URLs', () => {
    // A URL may legitimately carry /tree/main; a bare string may not, because
    // silently reading "a/b/c/d" as "a/b" answers about the wrong project.
    expect(normalizeRepoName('https://github.com/a/b/tree/main/src')).toBe('a/b');
    expect(normalizeRepoName('a/b/c/d')).toBeNull();
  });

  it('rejects an absurdly long input without scanning it all', () => {
    expect(normalizeRepoName(`${'a'.repeat(400)}/b`)).toBeNull();
  });
});

describe('askRepo', () => {
  it('returns the answer text on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(toolContent('Routing lives in app/router.ts.')));
    const r = await askRepo('facebook/react', 'where is routing?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('app/router.ts');
      expect(r.truncated).toBe(false);
    }
  });

  it('reports an unindexed repo as not_indexed, not as an answer', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse(
          toolContent(
            'Error processing question: Repository not found. Visit https://deepwiki.com to index it. Requested repos: nst-sdc/Open-Source-Tracker-NST',
          ),
        ),
      );
    const r = await askRepo('nst-sdc/Open-Source-Tracker-NST', 'what is this?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_indexed');
  });

  it('validates the repo before making any network call', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const r = await askRepo('not a repo', 'hi');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_repo');
    expect(spy).not.toHaveBeenCalled();
  });

  it('requires a question', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const r = await askRepo('facebook/react', '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_repo');
    expect(spy).not.toHaveBeenCalled();
  });

  it('never forwards credentials or cookies', async () => {
    const spy = vi.fn().mockResolvedValue(sseResponse(toolContent('ok')));
    globalThis.fetch = spy;
    await askRepo('facebook/react', 'q');
    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(init.redirect).toBe('error');
  });

  it('truncates a long answer so one call cannot eat the token budget', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(toolContent('x'.repeat(50_000))));
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(1800);
    }
  });

  it('treats a transport failure as unavailable rather than throwing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timed out'));
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unavailable');
  });

  it('treats a JSON-RPC error as unavailable', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(sseResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }));
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unavailable');
  });

  it('accepts a plain JSON response as well as SSE', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(toolContent('plain json answer')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('plain json answer');
  });

  it('reads structuredContent when there is no content array', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse({ jsonrpc: '2.0', id: 1, result: { structuredContent: { result: 'structured answer' } } }),
    );
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('structured answer');
  });

  it('can be switched off entirely', async () => {
    process.env.DEEPWIKI_DISABLED = '1';
    const spy = vi.fn();
    globalThis.fetch = spy;
    const r = await askRepo('facebook/react', 'q');
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports an unindexed repo as a refusal, with no second attempt', async () => {
    // Product decision: a repository DeepWiki has never seen is a refusal,
    // not a degraded GitHub-only answer that sounds equally confident.
    const spy = vi
      .fn()
      .mockResolvedValue(
        sseResponse(toolContent('Repository not found. Visit https://deepwiki.com to index it.')),
      );
    globalThis.fetch = spy;
    const r = await askRepo('nst-sdc/private-thing', 'q');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_indexed');
    // Exactly one call: there is no fallback path to a second service.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('repoTopics', () => {
  it('returns the structure on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(toolContent('1. Overview\n2. Architecture')));
    const r = await repoTopics('https://github.com/facebook/react');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Architecture');
  });

  it('validates the repo first', async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const r = await repoTopics('nonsense');
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
