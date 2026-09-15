// @vitest-environment node

import { afterEach, describe, expect, test, vi } from 'vitest';

import { POST } from '../app/api/generate/route';
import nextConfig from '../next.config';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;
const originalAuthRequired = process.env.DOC2ANKI_AUTH_REQUIRED;
const originalAllowedEmails = process.env.DOC2ANKI_ALLOWED_EMAILS;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
  if (originalAuthRequired === undefined) delete process.env.DOC2ANKI_AUTH_REQUIRED;
  else process.env.DOC2ANKI_AUTH_REQUIRED = originalAuthRequired;
  if (originalAllowedEmails === undefined) delete process.env.DOC2ANKI_ALLOWED_EMAILS;
  else process.env.DOC2ANKI_ALLOWED_EMAILS = originalAllowedEmails;
  vi.unstubAllGlobals();
});

describe('POST /api/generate', () => {
  test('allows the server to receive the full 25 MB upload envelope', () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe('30mb');
  });

  test('returns a useful configuration error without calling OpenAI when the API key is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new Request('http://localhost/api/generate', { method: 'POST' }));
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(503);
    expect(payload.error).toContain('OpenAI is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects unauthenticated generation before reading the source or calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.DOC2ANKI_AUTH_REQUIRED = 'true';
    process.env.DOC2ANKI_ALLOWED_EMAILS = 'friend@example.com';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(new Request('https://doc2anki.example/api/generate', { method: 'POST' }));
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(payload.error).toContain('Sign in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('combines both prompt levels, includes prior fronts, and returns parsed cards', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-5.6-luna';
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          source_title: 'Test source',
          cards: [{ front: 'New question', back: 'New answer', tags: ['topic'], source_hint: 'Section 1' }],
        }),
        usage: { input_tokens: 1_000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 500 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const form = new FormData();
    form.set('sourceKind', 'text');
    form.set('sourceName', 'Test source');
    form.set('globalPrompt', 'Prefer mechanisms.');
    form.set('documentPrompt', 'Focus on chapter two.');
    form.set('model', 'gpt-5.6-terra');
    form.set('count', '5');
    form.set('content', 'This source contains enough words to exercise the generation endpoint without using a live model.');
    form.set('existingFronts', JSON.stringify(['Existing question']));

    const response = await POST(new Request('http://localhost/api/generate', { method: 'POST', body: form }));
    const payload = await response.json() as {
      cards: Array<{ front: string }>;
      sourceTitle: string;
      usage: { model: string; estimatedCostUsd: number };
    };
    const openAIRequest = JSON.parse(String(capturedInit?.body));

    expect(response.status).toBe(200);
    expect(capturedUrl).toBe('https://api.openai.com/v1/responses');
    expect(openAIRequest.model).toBe('gpt-5.6-terra');
    expect(openAIRequest.store).toBe(false);
    expect(openAIRequest.instructions).toContain('Prefer mechanisms.');
    expect(openAIRequest.instructions).toContain('Focus on chapter two.');
    expect(openAIRequest.input[0].content[0].text).toContain('Existing question');
    expect(openAIRequest.input[0].content[1].text).toContain('This source contains enough words');
    expect(payload.cards[0]?.front).toBe('New question');
    expect(payload.sourceTitle).toBe('Test source');
    expect(payload.usage.model).toBe('gpt-5.6-terra');
    expect(payload.usage.estimatedCostUsd).toBeCloseTo(0.00782);
  });
});
