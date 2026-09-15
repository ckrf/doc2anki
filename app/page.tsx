'use client';

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import ApkgBuilder, { Card, Collection, Deck } from 'apkg-browser-builder';
import sqlWasmDataUrl from 'apkg-browser-builder/dist/sql-wasm-browser.wasm?inline';

import { createAnkiTextBackup, toAnkiHtml } from '../lib/anki-format';

import {
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  estimateTokenCostUsd,
  getModelConfig,
  isModelId,
  type ModelId,
} from '../lib/model-catalog';

type Source = {
  kind: 'file' | 'text' | 'url';
  name: string;
  detail: string;
  file?: File;
  content?: string;
  url?: string;
  autoTitle?: boolean;
  restored?: boolean;
};

type CandidateCard = {
  id: string;
  front: string;
  back: string;
  tags: string[];
  sourceHint: string;
  selected: boolean;
  revealed: boolean;
  batch: number;
};

type GenerationPayload = {
  cards?: Array<{ front: string; back: string; tags?: string[]; source_hint?: string }>;
  sourceTitle?: string;
  usage?: {
    model: ModelId;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
  error?: string;
};

type CostHistory = Partial<Record<ModelId, { costUsd: number; cards: number; runs: number }>>;
type StoredReviewDraft = {
  source: Pick<Source, 'kind' | 'name' | 'detail' | 'content' | 'url'>;
  cards: CandidateCard[];
  documentPrompt: string;
};

const DEFAULT_GLOBAL_PROMPT =
  'Prioritize conceptual relationships, mechanisms, and questions that require active recall. Avoid trivia, vague prompts, and simple recognition.';
const GLOBAL_PROMPT_STORAGE_KEY = 'doc2anki.global-prompt.v1';
const MODEL_STORAGE_KEY = 'doc2anki.model.v1';
const COST_HISTORY_STORAGE_KEY = 'doc2anki.cost-history.v1';
const REVIEW_DRAFT_STORAGE_KEY = 'doc2anki.review-draft.v1';
const LEGACY_STORAGE_KEYS = {
  globalPrompt: 'laxu-focus.global-prompt.v1',
  model: 'laxu-focus.model.v1',
  costHistory: 'laxu-focus.cost-history.v1',
  reviewDraft: 'laxu-focus.review-draft.v1',
};
const STARTING_INPUT_TOKENS_PER_CARD = 2_500;
const STARTING_OUTPUT_TOKENS_PER_CARD = 200;

function uid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeDeckName(name: string) {
  return name.replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Doc2Anki Flashcards';
}

function isOpaqueFileName(name: string) {
  const stem = name.replace(/\.[^/.]+$/, '');
  return stem.length >= 24 && /^[A-Za-z0-9_-]+$/.test(stem);
}

function cleanGeneratedTitle(title: string) {
  return title
    .replace(/\.(pdf|docx|txt|md|csv)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function formatUsd(value: number) {
  if (value < 0.001) return `$${value.toFixed(5)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

function readReviewDraft(raw: string | null): StoredReviewDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredReviewDraft>;
    const source = parsed.source;
    if (
      !source
      || !['file', 'text', 'url'].includes(source.kind)
      || typeof source.name !== 'string'
      || typeof source.detail !== 'string'
      || !Array.isArray(parsed.cards)
    ) return null;

    const cards = parsed.cards.filter((card): card is CandidateCard => Boolean(
      card
      && typeof card.id === 'string'
      && typeof card.front === 'string'
      && typeof card.back === 'string'
      && Array.isArray(card.tags)
      && card.tags.every((tag) => typeof tag === 'string')
      && typeof card.sourceHint === 'string'
      && typeof card.selected === 'boolean'
      && typeof card.revealed === 'boolean'
      && typeof card.batch === 'number',
    )).slice(0, 500);
    if (!cards.length) return null;
    return {
      source: {
        kind: source.kind,
        name: source.name.slice(0, 180),
        detail: source.detail.slice(0, 500),
        content: typeof source.content === 'string' ? source.content.slice(0, 350_000) : undefined,
        url: typeof source.url === 'string' ? source.url : undefined,
      },
      cards,
      documentPrompt: typeof parsed.documentPrompt === 'string' ? parsed.documentPrompt.slice(0, 8_000) : '',
    };
  } catch {
    return null;
  }
}

function saveAnkiTextBackup(cards: CandidateCard[], deckName: string) {
  const content = createAnkiTextBackup(cards);
  const blob = new Blob([content], { type: 'text/tab-separated-values;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${deckName}-Anki-backup.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

function embeddedWasmBinary() {
  const base64 = sqlWasmDataUrl.slice(sqlWasmDataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function readGenerationPayload(response: Response): Promise<GenerationPayload> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as GenerationPayload;
  } catch {
    if (response.status === 413) {
      return {
        error: 'The server rejected this upload before it reached Doc2Anki. Reload the app and try again; files up to 25 MB are supported.',
      };
    }
    return { error: raw.trim() || 'The server returned an unreadable response. Please try again.' };
  }
}

export default function Home() {
  const [globalPrompt, setGlobalPrompt] = useState(DEFAULT_GLOBAL_PROMPT);
  const [savedGlobalPrompt, setSavedGlobalPrompt] = useState(DEFAULT_GLOBAL_PROMPT);
  const [documentPrompt, setDocumentPrompt] = useState('');
  const [modelId, setModelId] = useState<ModelId>(DEFAULT_MODEL_ID);
  const [costHistory, setCostHistory] = useState<CostHistory>({});
  const [source, setSource] = useState<Source | null>(null);
  const [cards, setCards] = useState<CandidateCard[]>([]);
  const [candidateCount, setCandidateCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [notice, setNotice] = useState('');
  const [sourceDialogOpen, setSourceDialogOpen] = useState(true);
  const [sourceTab, setSourceTab] = useState<'upload' | 'link' | 'text'>('upload');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftText, setDraftText] = useState('');
  const [textTitle, setTextTitle] = useState('Pasted notes');
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<'all' | 'selected'>('all');
  const [draftReady, setDraftReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedCount = cards.filter((card) => card.selected).length;
  const selectedModel = getModelConfig(modelId);
  const selectedModelHistory = costHistory[modelId];
  const selectedCostPerCard = selectedModelHistory?.cards
    ? selectedModelHistory.costUsd / selectedModelHistory.cards
    : estimateTokenCostUsd(modelId, STARTING_INPUT_TOKENS_PER_CARD, 0, STARTING_OUTPUT_TOKENS_PER_CARD);
  const visibleCards = useMemo(
    () => (filter === 'selected' ? cards.filter((card) => card.selected) : cards),
    [cards, filter],
  );

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const storedPrompt = localStorage.getItem(GLOBAL_PROMPT_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEYS.globalPrompt);
      if (storedPrompt !== null) {
        setGlobalPrompt(storedPrompt);
        setSavedGlobalPrompt(storedPrompt);
        localStorage.setItem(GLOBAL_PROMPT_STORAGE_KEY, storedPrompt);
      }

      const storedModel = localStorage.getItem(MODEL_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEYS.model);
      if (storedModel && isModelId(storedModel)) {
        setModelId(storedModel);
        localStorage.setItem(MODEL_STORAGE_KEY, storedModel);
      }

      const storedHistory = localStorage.getItem(COST_HISTORY_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEYS.costHistory);
      if (storedHistory) {
        try {
          const parsed = JSON.parse(storedHistory) as CostHistory;
          if (parsed && typeof parsed === 'object') {
            setCostHistory(parsed);
            localStorage.setItem(COST_HISTORY_STORAGE_KEY, storedHistory);
          }
        } catch {
          localStorage.removeItem(COST_HISTORY_STORAGE_KEY);
        }
      }

      const reviewDraft = readReviewDraft(localStorage.getItem(REVIEW_DRAFT_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEYS.reviewDraft));
      if (reviewDraft) {
        localStorage.setItem(REVIEW_DRAFT_STORAGE_KEY, JSON.stringify(reviewDraft));
        const canRegenerate = Boolean(reviewDraft.source.content || reviewDraft.source.url);
        setSource({ ...reviewDraft.source, restored: !canRegenerate });
        setCards(reviewDraft.cards);
        setDocumentPrompt(reviewDraft.documentPrompt);
        setSourceDialogOpen(false);
        setNotice(`${reviewDraft.cards.length} saved candidate${reviewDraft.cards.length === 1 ? '' : 's'} restored for review and export.`);
      }
      setDraftReady(true);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    const saveTimer = window.setTimeout(() => {
      if (!source || cards.length === 0) {
        localStorage.removeItem(REVIEW_DRAFT_STORAGE_KEY);
        return;
      }
      const reviewDraft: StoredReviewDraft = {
        source: {
          kind: source.kind,
          name: source.name,
          detail: source.detail,
          content: source.content?.slice(0, 350_000),
          url: source.url,
        },
        cards,
        documentPrompt,
      };
      try {
        localStorage.setItem(REVIEW_DRAFT_STORAGE_KEY, JSON.stringify(reviewDraft));
      } catch {
        // The review remains usable in memory if browser storage is unavailable.
      }
    }, 150);
    return () => window.clearTimeout(saveTimer);
  }, [cards, documentPrompt, draftReady, source]);

  function saveGlobalPrompt() {
    localStorage.setItem(GLOBAL_PROMPT_STORAGE_KEY, globalPrompt);
    setSavedGlobalPrompt(globalPrompt);
    setNotice('Global study prompt saved for future sessions in this browser.');
  }

  function chooseModel(value: string) {
    if (!isModelId(value)) return;
    setModelId(value);
    localStorage.setItem(MODEL_STORAGE_KEY, value);
  }

  function estimatedCardCost(candidateModel: ModelId) {
    const history = costHistory[candidateModel];
    return history?.cards
      ? history.costUsd / history.cards
      : estimateTokenCostUsd(candidateModel, STARTING_INPUT_TOKENS_PER_CARD, 0, STARTING_OUTPUT_TOKENS_PER_CARD);
  }

  function recordUsage(payload: GenerationPayload['usage'], cardsReturned: number) {
    if (!payload || cardsReturned < 1 || payload.estimatedCostUsd < 0) return;
    setCostHistory((current) => {
      const previous = current[payload.model] ?? { costUsd: 0, cards: 0, runs: 0 };
      const next: CostHistory = {
        ...current,
        [payload.model]: {
          costUsd: previous.costUsd + payload.estimatedCostUsd,
          cards: previous.cards + cardsReturned,
          runs: previous.runs + 1,
        },
      };
      localStorage.setItem(COST_HISTORY_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function acceptFile(file?: File) {
    if (!file) {
      setSourceError('No local file was received. Use “Choose a file” below, or use the Link tab for a public document.');
      return;
    }
    const allowed = [
      'application/pdf',
      'application/x-pdf',
      'application/acrobat',
      'text/plain',
      'text/markdown',
      'text/csv',
      'image/png',
      'image/jpeg',
      'image/webp',
      'audio/mpeg',
      'audio/mp4',
      'audio/wav',
      'audio/x-m4a',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const hasSupportedName = /\.(pdf|txt|md|csv|png|jpe?g|webp|mp3|m4a|wav|docx)$/i.test(file.name.trim());
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const hasPdfHeader = header.length >= 5 && String.fromCharCode(...header) === '%PDF-';
    if (!allowed.includes(file.type.toLowerCase()) && !hasSupportedName && !hasPdfHeader) {
      const detectedType = file.type ? ` (${file.type})` : '';
      setSourceError(`“${file.name || 'This file'}” is not a supported document${detectedType}. Try PDF, DOCX, image, audio, Markdown, CSV, or plain text.`);
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setSourceError(`“${file.name}” is ${humanSize(file.size)}. For this MVP, files must be 25 MB or smaller.`);
      return;
    }
    const normalizedFile = hasPdfHeader && !hasSupportedName
      ? new File([file], file.name.toLowerCase().endsWith('.pdf') ? file.name : `${file.name || 'source'}.pdf`, { type: 'application/pdf' })
      : file;
    const autoTitle = isOpaqueFileName(normalizedFile.name);
    setSource({
      kind: 'file',
      name: autoTitle ? 'Untitled PDF' : normalizedFile.name,
      detail: `${humanSize(normalizedFile.size)} · ${normalizedFile.type || 'document'}${autoTitle ? ' · title will be detected during generation' : ''}`,
      file: normalizedFile,
      autoTitle,
    });
    setCards([]);
    setError('');
    setSourceError('');
    setNotice('Source added. Add an optional document prompt, then generate your first candidates.');
    setSourceDialogOpen(false);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void acceptFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void acceptFile(event.dataTransfer.files?.[0]);
  }

  function openSourceDialog() {
    setSourceError('');
    setError('');
    setSourceDialogOpen(true);
  }

  function selectSourceTab(tab: 'upload' | 'link' | 'text') {
    setSourceTab(tab);
    setSourceError('');
  }

  function addLink() {
    const value = draftUrl.trim();
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
      setSource({ kind: 'url', name: parsed.hostname.replace(/^www\./, ''), detail: value, url: value });
      setCards([]);
      setError('');
      setSourceError('');
      setNotice('Link added. Public webpages and public document links work best.');
      setSourceDialogOpen(false);
    } catch {
      setSourceError('Enter a complete public http:// or https:// link.');
    }
  }

  function addText() {
    if (draftText.trim().length < 40) {
      setSourceError('Paste at least a short paragraph so there is enough material to study.');
      return;
    }
    const title = textTitle.trim() || 'Pasted notes';
    setSource({ kind: 'text', name: title, detail: `${draftText.trim().split(/\s+/).length} words`, content: draftText.trim() });
    setCards([]);
    setError('');
    setSourceError('');
    setNotice('Text added. You can now generate candidate cards.');
    setSourceDialogOpen(false);
  }

  async function generateCards() {
    if (!source) {
      openSourceDialog();
      return;
    }
    if (source.restored && !source.file && !source.content && !source.url) {
      setError('Your saved cards are safe to edit and export. Re-add the original file before generating more cards from it.');
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const form = new FormData();
      form.set('sourceKind', source.kind);
      form.set('sourceName', source.name);
      form.set('globalPrompt', globalPrompt.trim());
      form.set('documentPrompt', documentPrompt.trim());
      form.set('model', modelId);
      form.set('count', String(candidateCount));
      form.set('existingFronts', JSON.stringify(cards.map((card) => card.front)));
      if (source.file) form.set('file', source.file);
      if (source.content) form.set('content', source.content);
      if (source.url) form.set('url', source.url);

      const response = await fetch('/api/generate', { method: 'POST', body: form });
      const payload = await readGenerationPayload(response);
      if (!response.ok || !payload.cards) throw new Error(payload.error || 'The cards could not be generated.');

      let resolvedSourceName = source.name;
      if (source.autoTitle && payload.sourceTitle) {
        const generatedTitle = cleanGeneratedTitle(payload.sourceTitle);
        if (generatedTitle) {
          const extension = source.file?.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '';
          resolvedSourceName = `${generatedTitle}${extension}`;
          setSource((current) => current?.autoTitle
            ? { ...current, name: resolvedSourceName, autoTitle: false }
            : current);
        }
      }

      const batch = cards.reduce((highest, card) => Math.max(highest, card.batch), 0) + 1;
      const incoming = payload.cards.map((card) => ({
        id: uid(),
        front: card.front,
        back: card.back,
        tags: card.tags?.length ? card.tags : ['general'],
        sourceHint: card.source_hint || resolvedSourceName,
        selected: false,
        revealed: false,
        batch,
      }));
      setCards((current) => [...current, ...incoming]);
      recordUsage(payload.usage, incoming.length);
      const costMessage = payload.usage
        ? ` Estimated API cost: ${formatUsd(payload.usage.estimatedCostUsd)} (${formatUsd(payload.usage.estimatedCostUsd / incoming.length)}/card).`
        : '';
      setNotice(`${incoming.length} new candidate${incoming.length === 1 ? '' : 's'} added to the review queue.${costMessage}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong while generating cards.');
    } finally {
      setLoading(false);
    }
  }

  function updateCard(id: string, field: 'front' | 'back', value: string) {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, [field]: value } : card)));
  }

  function toggleCard(id: string) {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, selected: !card.selected } : card)));
  }

  function toggleAnswer(id: string) {
    setCards((current) => current.map((card) => (card.id === id ? { ...card, revealed: !card.revealed } : card)));
  }

  function removeCard(id: string) {
    setCards((current) => current.filter((card) => card.id !== id));
  }

  function setAllSelected(selected: boolean) {
    setCards((current) => current.map((card) => ({ ...card, selected })));
  }

  async function exportToAnki() {
    const selected = cards.filter((card) => card.selected && card.front.trim() && card.back.trim());
    if (!selected.length || !source) return;
    setExporting(true);
    setError('');
    const deckName = safeDeckName(source.name);
    try {
      const collection = new Collection();
      const deck = new Deck(deckName, `Created with Doc2Anki from ${source.name}`);
      collection.addDeck(deck);
      selected.forEach((candidate, index) => {
        const card = new Card(toAnkiHtml(candidate.front.trim()), toAnkiHtml(candidate.back.trim()));
        card.setDue(index + 1);
        deck.addCard(card);
      });
      const builder = new ApkgBuilder(collection, { sqljs: { wasmBinary: embeddedWasmBinary() } });
      await builder.save(`${deckName}.apkg`);
      setNotice(`${selected.length} selected card${selected.length === 1 ? '' : 's'} exported to Anki.`);
    } catch (caught) {
      try {
        saveAnkiTextBackup(selected, deckName);
        const reason = caught instanceof Error ? ` (${caught.message})` : '';
        setNotice(`The .apkg builder was unavailable${reason}. Your ${selected.length} selected card${selected.length === 1 ? '' : 's'} were saved as an Anki-importable text backup instead.`);
      } catch (backupError) {
        setError(backupError instanceof Error ? `Anki export failed: ${backupError.message}` : 'Anki export failed.');
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">D</div>
        <div className="brand-copy">
          <strong>Doc2Anki</strong>
          <span>Flashcard studio</span>
        </div>
        <a className="admin-link" href="/admin">Manage friends</a>
        <div className="topbar-status"><span /> {loading ? 'Generating candidates…' : 'Ready'}</div>
      </header>

      <aside className="prompt-panel">
        <div className="eyebrow">Prompt controls</div>
        <h1>Teach the model what matters.</h1>
        <label htmlFor="global-prompt">Global study prompt</label>
        <textarea
          id="global-prompt"
          value={globalPrompt}
          onChange={(event) => setGlobalPrompt(event.target.value)}
          placeholder="What should every deck focus on?"
        />
        <div className="prompt-save-row">
          <span>{globalPrompt === savedGlobalPrompt ? 'Saved' : 'Unsaved changes'}</span>
          <button onClick={saveGlobalPrompt} disabled={globalPrompt === savedGlobalPrompt}>Save global prompt</button>
        </div>
        <p className="field-help">Applied to every source you generate from and saved in this browser.</p>
        <label htmlFor="document-prompt">This document</label>
        <textarea
          id="document-prompt"
          value={documentPrompt}
          onChange={(event) => setDocumentPrompt(event.target.value)}
          placeholder="Optional: emphasize a chapter, skill, question style, or level of detail."
        />
        <p className="field-help">Combined with the global prompt for this source.</p>
        <label htmlFor="generation-model">Generation model</label>
        <select id="generation-model" className="model-select" value={modelId} onChange={(event) => chooseModel(event.target.value)}>
          {MODEL_CATALOG.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · ≈{formatUsd(estimatedCardCost(model.id))}/card
            </option>
          ))}
        </select>
        <div className="model-summary">
          <strong>Estimated cost/card: ≈{formatUsd(selectedCostPerCard)}</strong>
          <span>{selectedModelHistory
            ? `Based on ${selectedModelHistory.cards} generated cards across ${selectedModelHistory.runs} run${selectedModelHistory.runs === 1 ? '' : 's'}.`
            : 'Starting estimate; it will be replaced by your observed average after the first run.'}</span>
          <small>{selectedModel.description} ${selectedModel.inputUsdPerMillion}/M input · ${selectedModel.outputUsdPerMillion}/M output. Actual cost varies with document length and batch size.</small>
        </div>
        <div className="prompt-note">
          <strong>Prompt hierarchy</strong>
          Global guidance sets your study style. Document guidance narrows the focus without replacing it.
        </div>
      </aside>

      <section className="workspace">
        <div className="workspace-head">
          <div>
            <div className="eyebrow">Current source</div>
            <h2>{source?.name || 'Choose something to study'}</h2>
            <p>{source?.detail || 'Upload a document, paste notes, or add a public link.'}</p>
          </div>
          <button className="source-button" onClick={openSourceDialog}>＋ {source ? 'Change source' : 'Add source'}</button>
        </div>

        {error && <div className="message error-message" role="alert"><strong>Something needs attention</strong>{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {notice && <div className="message notice-message" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

        {!source ? (
          <button className="empty-state" onClick={openSourceDialog}>
            <span className="empty-icon">＋</span>
            <strong>Add your first source</strong>
            <small>PDF, DOCX, image, audio, pasted text, or public link</small>
          </button>
        ) : cards.length === 0 ? (
          <section className="generation-start">
            <div className="generation-ornament">A → B</div>
            <h3>Turn this source into active-recall cards.</h3>
            <p>Your prompts are combined with the source. Every result starts as a candidate, so nothing reaches Anki until you review and select it.</p>
            <div className="generation-controls">
              <label htmlFor="initial-count">Candidates</label>
              <select id="initial-count" value={candidateCount} onChange={(event) => setCandidateCount(Number(event.target.value))}>
                {[5, 10, 15, 20].map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
              <button className="primary-button large-button" onClick={generateCards} disabled={loading}>
                {loading ? <><span className="spinner" /> Generating…</> : 'Generate candidates'}
              </button>
            </div>
          </section>
        ) : (
          <>
            <div className="review-toolbar">
              <div className="review-title"><strong>Review candidates</strong><span>{selectedCount} of {cards.length} selected</span></div>
              <div className="filter-tabs" aria-label="Filter cards">
                <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All {cards.length}</button>
                <button className={filter === 'selected' ? 'active' : ''} onClick={() => setFilter('selected')}>Selected {selectedCount}</button>
              </div>
              <select aria-label="Number of additional candidates" value={candidateCount} onChange={(event) => setCandidateCount(Number(event.target.value))}>
                {[5, 10, 15, 20].map((count) => <option key={count} value={count}>{count} more</option>)}
              </select>
              <button className="secondary-button" onClick={generateCards} disabled={loading}>
                {loading ? <><span className="spinner dark" /> Generating</> : 'Generate more'}
              </button>
              <button className="primary-button" onClick={exportToAnki} disabled={!selectedCount || exporting}>
                {exporting ? 'Building deck…' : `Export ${selectedCount || ''} to Anki`}
              </button>
            </div>

            <div className="bulk-row">
              <button onClick={() => setAllSelected(true)}>Select all</button>
              <button onClick={() => setAllSelected(false)}>Clear selection</button>
              <span>Edits and selections are saved automatically for recovery.</span>
            </div>

            <div className="cards-list">
              {visibleCards.length === 0 ? (
                <div className="no-results">No cards are selected yet. Return to “All” to choose some.</div>
              ) : visibleCards.map((card, index) => (
                <article className={`candidate-card ${card.selected ? 'selected' : ''}`} key={card.id}>
                  <div className="card-select">
                    <input aria-label={`Select card ${index + 1}`} type="checkbox" checked={card.selected} onChange={() => toggleCard(card.id)} />
                  </div>
                  <div className="card-number">{String(cards.indexOf(card) + 1).padStart(2, '0')}</div>
                  <div className="card-fields">
                    <div className="card-field">
                      <label htmlFor={`front-${card.id}`}>Front</label>
                      <textarea id={`front-${card.id}`} value={card.front} onChange={(event) => updateCard(card.id, 'front', event.target.value)} />
                    </div>
                    <div className="card-field">
                      <div className="field-heading">
                        <label htmlFor={card.revealed ? `back-${card.id}` : undefined}>Back</label>
                        {card.revealed && <button onClick={() => toggleAnswer(card.id)}>Hide answer</button>}
                      </div>
                      {card.revealed ? (
                        <textarea id={`back-${card.id}`} aria-label="Back" value={card.back} onChange={(event) => updateCard(card.id, 'back', event.target.value)} />
                      ) : (
                        <button className="hidden-answer" aria-label="Show and edit answer" onClick={() => toggleAnswer(card.id)}>
                          <span>Answer hidden</span>
                          <strong>Show and edit answer</strong>
                        </button>
                      )}
                    </div>
                    <div className="tag-row">
                      <span className="batch-tag">Batch {card.batch}</span>
                      {card.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
                      <em title={card.sourceHint}>{card.sourceHint}</em>
                      <button onClick={() => removeCard(card.id)}>Delete</button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      {sourceDialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && source && setSourceDialogOpen(false)}>
          <section className="source-dialog" role="dialog" aria-modal="true" aria-labelledby="source-dialog-title">
            <button className="dialog-close" onClick={() => source ? setSourceDialogOpen(false) : undefined} disabled={!source} aria-label="Close">×</button>
            <div className="eyebrow">Source material</div>
            <h2 id="source-dialog-title">What are you studying?</h2>
            <p>Choose one source for this deck. You can replace it whenever you like.</p>
            <div className="source-tabs" role="tablist">
              <button className={sourceTab === 'upload' ? 'active' : ''} onClick={() => selectSourceTab('upload')}>Upload</button>
              <button className={sourceTab === 'link' ? 'active' : ''} onClick={() => selectSourceTab('link')}>Link</button>
              <button className={sourceTab === 'text' ? 'active' : ''} onClick={() => selectSourceTab('text')}>Paste text</button>
            </div>

            {sourceError && <div className="source-error" role="alert"><strong>Couldn’t add that source</strong>{sourceError}</div>}

            {sourceTab === 'upload' && (
              <label
                htmlFor="source-file"
                className={`drop-zone ${dragging ? 'dragging' : ''}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input id="source-file" ref={fileInput} className="source-file-input" type="file" onChange={onFileChange} accept=".pdf,.docx,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,application/pdf" />
                <span className="upload-symbol">↑</span>
                <strong>Choose a file</strong>
                <span className="drop-hint">or drop a local file here</span>
                <small>PDF, DOCX, text, image, or audio · up to 25 MB</small>
              </label>
            )}

            {sourceTab === 'link' && (
              <div className="source-form">
                <label htmlFor="source-url">Public webpage or document link</label>
                <input id="source-url" type="url" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder="https://…" onKeyDown={(event) => event.key === 'Enter' && addLink()} />
                <p>Public webpages and public Google Docs links are supported in this MVP.</p>
                <button className="primary-button" onClick={addLink}>Use this link</button>
              </div>
            )}

            {sourceTab === 'text' && (
              <div className="source-form">
                <label htmlFor="text-title">Source title</label>
                <input id="text-title" value={textTitle} onChange={(event) => setTextTitle(event.target.value)} />
                <label htmlFor="source-text">Notes or source text</label>
                <textarea id="source-text" value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Paste lecture notes, a chapter excerpt, an outline…" />
                <button className="primary-button" onClick={addText}>Use this text</button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
