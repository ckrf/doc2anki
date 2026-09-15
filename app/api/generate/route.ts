import { DEFAULT_MODEL_ID, estimateTokenCostUsd, isModelId } from '../../../lib/model-catalog';
import {
  FixedWindowRateLimiter,
  GenerationQueue,
  GenerationQueueFullError,
  positiveInteger,
} from '../../../lib/generation-guard';
import { assertPublicHttpUrl } from '../../../lib/public-url';
import { authorizeGenerationRequest } from '../../../lib/server-access';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_CHARS = 350_000;
const MAX_LINK_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const LINK_TIMEOUT_MS = 20_000;
const generationRateLimiter = new FixedWindowRateLimiter(
  positiveInteger(process.env.DOC2ANKI_REQUESTS_PER_HOUR, 20),
  60 * 60 * 1_000,
);
const generationQueue = new GenerationQueue(
  positiveInteger(process.env.DOC2ANKI_MAX_CONCURRENT_GENERATIONS, 2),
  positiveInteger(process.env.DOC2ANKI_MAX_QUEUED_GENERATIONS, 20),
);

type OpenAIError = { error?: { message?: string } };
type OpenAIUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
};
type SourceContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_file'; filename: string; file_data: string }
  | { type: 'input_image'; image_url: string };

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function stripHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function publicDocumentUrl(value: string) {
  const match = value.match(/^https:\/\/docs\.google\.com\/document\/d\/([^/]+)/i);
  return match ? `https://docs.google.com/document/d/${match[1]}/export?format=txt` : value;
}

async function readResponseBytes(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('The linked source is too large.');
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('The linked source is too large.');
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function fetchPublicSource(initialUrl: URL) {
  let current = await assertPublicHttpUrl(initialUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
      headers: { 'User-Agent': 'Doc2Anki/1.0 (+flashcard-generator)', Accept: 'text/html,text/plain,application/pdf' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };

    const location = response.headers.get('location');
    if (!location) throw new Error('The linked source returned an invalid redirect.');
    if (redirects === MAX_REDIRECTS) throw new Error('The linked source redirected too many times.');
    const next = await assertPublicHttpUrl(new URL(location, current));
    if (current.protocol === 'https:' && next.protocol !== 'https:') {
      throw new Error('The linked source redirected to an insecure address.');
    }
    current = next;
  }

  throw new Error('The linked source could not be loaded.');
}

async function fetchLinkedSource(value: string): Promise<{ content: SourceContent; note: string }> {
  let parsed: URL;
  try {
    parsed = new URL(publicDocumentUrl(value));
  } catch {
    throw new Error('The source link is not a valid URL.');
  }
  const { response, finalUrl } = await fetchPublicSource(parsed);
  if (!response.ok) throw new Error(`The linked source returned ${response.status}. Check that it is public.`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    const bytes = await readResponseBytes(response, MAX_FILE_BYTES);
    return {
      content: {
        type: 'input_file',
        filename: finalUrl.pathname.split('/').pop() || 'linked-source.pdf',
        file_data: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
      },
      note: 'the linked PDF',
    };
  }
  const raw = new TextDecoder().decode(await readResponseBytes(response, MAX_LINK_TEXT_BYTES));
  const text = contentType.includes('html') ? stripHtml(raw) : raw.trim();
  if (text.length < 40) throw new Error('The linked page did not expose enough readable text.');
  return { content: { type: 'input_text', text: `SOURCE CONTENT:\n${text.slice(0, MAX_SOURCE_CHARS)}` }, note: value };
}

async function transcribeAudio(file: File, apiKey: string) {
  const form = new FormData();
  form.set('file', file, file.name);
  form.set('model', 'gpt-4o-mini-transcribe');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const payload = (await response.json()) as { text?: string } & OpenAIError;
  if (!response.ok || !payload.text) throw new Error(payload.error?.message || 'The audio could not be transcribed.');
  return payload.text;
}

function responseOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as { content?: unknown[] }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'output_text' && typeof (part as { text?: string }).text === 'string') {
        return (part as { text: string }).text;
      }
    }
  }
  return '';
}

async function generateCards(request: Request, apiKey: string) {
  try {
    const form = await request.formData();
    const sourceKind = String(form.get('sourceKind') || '');
    const sourceName = String(form.get('sourceName') || 'Source material').slice(0, 180);
    const globalPrompt = String(form.get('globalPrompt') || '').slice(0, 8_000);
    const documentPrompt = String(form.get('documentPrompt') || '').slice(0, 8_000);
    const requestedModel = String(form.get('model') || '');
    const configuredModel = String(process.env.OPENAI_MODEL || '');
    const model = isModelId(requestedModel)
      ? requestedModel
      : isModelId(configuredModel) ? configuredModel : DEFAULT_MODEL_ID;
    const requestedCount = Number(form.get('count') || 10);
    const count = [5, 10, 15, 20].includes(requestedCount) ? requestedCount : 10;
    let existingFronts: string[] = [];
    try {
      const parsed = JSON.parse(String(form.get('existingFronts') || '[]'));
      if (Array.isArray(parsed)) existingFronts = parsed.filter((item): item is string => typeof item === 'string').slice(-100);
    } catch {
      existingFronts = [];
    }

    let sourceContent: SourceContent;
    let sourceNote = sourceName;
    if (sourceKind === 'file') {
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) return jsonError('Choose a source file first.');
      if (file.size > MAX_FILE_BYTES) return jsonError('Files must be 25 MB or smaller.');
      if (file.type.startsWith('audio/') || /\.(mp3|m4a|wav)$/i.test(file.name)) {
        const transcript = await transcribeAudio(file, apiKey);
        sourceContent = { type: 'input_text', text: `AUDIO TRANSCRIPT:\n${transcript.slice(0, MAX_SOURCE_CHARS)}` };
        sourceNote = `${file.name} transcript`;
      } else if (file.type.startsWith('text/') || /\.(txt|md|csv)$/i.test(file.name)) {
        const text = await file.text();
        sourceContent = { type: 'input_text', text: `SOURCE CONTENT:\n${text.slice(0, MAX_SOURCE_CHARS)}` };
      } else if (file.type.startsWith('image/')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        sourceContent = { type: 'input_image', image_url: `data:${file.type};base64,${bytesToBase64(bytes)}` };
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        sourceContent = {
          type: 'input_file',
          filename: file.name,
          file_data: `data:${file.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`,
        };
      }
    } else if (sourceKind === 'text') {
      const text = String(form.get('content') || '').trim();
      if (text.length < 40) return jsonError('The pasted source is too short to generate useful cards.');
      sourceContent = { type: 'input_text', text: `SOURCE CONTENT:\n${text.slice(0, MAX_SOURCE_CHARS)}` };
    } else if (sourceKind === 'url') {
      const linked = await fetchLinkedSource(String(form.get('url') || ''));
      sourceContent = linked.content;
      sourceNote = linked.note;
    } else {
      return jsonError('Choose a source before generating cards.');
    }

    const instructions = [
      'You create high-quality active-recall flashcards grounded only in the supplied source.',
      'Each card must be self-contained, precise, and test one meaningful idea. Prefer explanation, comparison, causation, mechanism, and application over trivia or copied headings.',
      'Do not invent facts. Avoid duplicates and near-duplicates. The back should directly and completely answer the front without unnecessary preamble.',
      'Also identify the source with a concise, descriptive source_title. Prefer an evident book or article title plus chapter number and chapter topic. Never use an opaque file ID as the title.',
      globalPrompt ? `GLOBAL STUDY PROMPT (applies across all sources):\n${globalPrompt}` : '',
      documentPrompt ? `DOCUMENT-SPECIFIC PROMPT (additional focus for this source):\n${documentPrompt}` : '',
    ].filter(Boolean).join('\n\n');

    const existing = existingFronts.length
      ? `\nDo not repeat or lightly rephrase any of these existing fronts:\n- ${existingFronts.join('\n- ')}`
      : '';
    const userPrompt = `Create exactly ${count} new candidate flashcards from “${sourceName}”. Give each 1–3 concise internal topic labels and a short source_hint identifying the relevant section, page if evident, or “${sourceNote}” if no more precise location is available. Write mathematical notation as LaTeX using \\(…\\) for inline math and \\[…\\] for display math so it renders in Anki.${existing}`;

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: userPrompt }, sourceContent] }],
        text: {
          format: {
            type: 'json_schema',
            name: 'flashcard_candidates',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source_title: { type: 'string' },
                cards: {
                  type: 'array',
                  minItems: count,
                  maxItems: count,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      front: { type: 'string' },
                      back: { type: 'string' },
                      tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
                      source_hint: { type: 'string' },
                    },
                    required: ['front', 'back', 'tags', 'source_hint'],
                  },
                },
              },
              required: ['source_title', 'cards'],
            },
          },
        },
      }),
    });

    const payload = (await response.json()) as Record<string, unknown> & OpenAIError;
    if (!response.ok) {
      const apiMessage = payload.error?.message || 'OpenAI could not generate cards from this source.';
      return jsonError(apiMessage, response.status >= 500 ? 502 : 400);
    }
    const output = responseOutputText(payload);
    if (!output) return jsonError('The model returned no flashcards. Please try again.', 502);
    const parsed = JSON.parse(output) as { source_title?: string; cards?: unknown[] };
    if (!Array.isArray(parsed.cards)) return jsonError('The model returned an unexpected result. Please try again.', 502);
    const rawUsage = payload.usage as OpenAIUsage | undefined;
    const inputTokens = Math.max(0, Number(rawUsage?.input_tokens) || 0);
    const cachedInputTokens = Math.max(0, Number(rawUsage?.input_tokens_details?.cached_tokens) || 0);
    const outputTokens = Math.max(0, Number(rawUsage?.output_tokens) || 0);
    const usage = rawUsage ? {
      model,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      estimatedCostUsd: estimateTokenCostUsd(model, inputTokens, cachedInputTokens, outputTokens),
    } : undefined;
    return Response.json({
      cards: parsed.cards,
      sourceTitle: typeof parsed.source_title === 'string' ? parsed.source_title : undefined,
      usage,
    });
  } catch (caught) {
    return jsonError(caught instanceof Error ? caught.message : 'Card generation failed.', 500);
  }
}

export async function POST(request: Request) {
  const access = authorizeGenerationRequest(request);
  if (!access.allowed) return jsonError(access.message, access.status);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return jsonError('OpenAI is not configured for this deployment yet.', 503);

  const rateLimit = generationRateLimiter.take(access.actor);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: 'You have reached the hourly generation limit. Try again after the indicated wait.' },
      { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } },
    );
  }

  try {
    const response = await generationQueue.run(() => generateCards(request, apiKey));
    response.headers.set('X-RateLimit-Remaining', String(rateLimit.remaining));
    return response;
  } catch (caught) {
    if (caught instanceof GenerationQueueFullError) {
      return Response.json(
        { error: 'Doc2Anki is handling several generations right now. Please try again shortly.' },
        { status: 503, headers: { 'Retry-After': '15' } },
      );
    }
    return jsonError(caught instanceof Error ? caught.message : 'Card generation failed.', 500);
  }
}
