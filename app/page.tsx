'use client';

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from 'react';

type Source = {
  kind: 'file' | 'text' | 'url';
  name: string;
  detail: string;
  file?: File;
  content?: string;
  url?: string;
};

type CandidateCard = {
  id: string;
  front: string;
  back: string;
  tags: string[];
  sourceHint: string;
  selected: boolean;
  batch: number;
};

const DEFAULT_GLOBAL_PROMPT =
  'Prioritize conceptual relationships, mechanisms, and questions that require active recall. Avoid trivia, vague prompts, and simple recognition.';

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
  return name.replace(/\.[^/.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Laxu Flashcards';
}

export default function Home() {
  const [globalPrompt, setGlobalPrompt] = useState(DEFAULT_GLOBAL_PROMPT);
  const [documentPrompt, setDocumentPrompt] = useState('');
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
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedCount = cards.filter((card) => card.selected).length;
  const visibleCards = useMemo(
    () => (filter === 'selected' ? cards.filter((card) => card.selected) : cards),
    [cards, filter],
  );

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
    setSource({ kind: 'file', name: normalizedFile.name, detail: `${humanSize(normalizedFile.size)} · ${normalizedFile.type || 'document'}`, file: normalizedFile });
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
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const form = new FormData();
      form.set('sourceKind', source.kind);
      form.set('sourceName', source.name);
      form.set('globalPrompt', globalPrompt.trim());
      form.set('documentPrompt', documentPrompt.trim());
      form.set('count', String(candidateCount));
      form.set('existingFronts', JSON.stringify(cards.map((card) => card.front)));
      if (source.file) form.set('file', source.file);
      if (source.content) form.set('content', source.content);
      if (source.url) form.set('url', source.url);

      const response = await fetch('/api/generate', { method: 'POST', body: form });
      const payload = (await response.json()) as {
        cards?: Array<{ front: string; back: string; tags?: string[]; source_hint?: string }>;
        error?: string;
      };
      if (!response.ok || !payload.cards) throw new Error(payload.error || 'The cards could not be generated.');

      const batch = cards.reduce((highest, card) => Math.max(highest, card.batch), 0) + 1;
      const incoming = payload.cards.map((card) => ({
        id: uid(),
        front: card.front,
        back: card.back,
        tags: card.tags?.length ? card.tags : ['laxu'],
        sourceHint: card.source_hint || source.name,
        selected: false,
        batch,
      }));
      setCards((current) => [...current, ...incoming]);
      setNotice(`${incoming.length} new candidate${incoming.length === 1 ? '' : 's'} added to the review queue.`);
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
    try {
      const { default: ApkgBuilder, Collection, Deck, Card } = await import('apkg-browser-builder');
      const collection = new Collection();
      const deckName = safeDeckName(source.name);
      const deck = new Deck(deckName, `Created with Laxu Focus from ${source.name}`);
      collection.addDeck(deck);
      selected.forEach((candidate, index) => {
        const card = new Card(candidate.front.trim(), candidate.back.trim());
        card.setDue(index + 1);
        card.getNote()?.setTags([...new Set(['laxu-focus', ...candidate.tags.map((tag) => tag.replace(/\s+/g, '-'))])]);
        deck.addCard(card);
      });
      const builder = new ApkgBuilder(collection);
      await builder.save(`${deckName}.apkg`);
      setNotice(`${selected.length} selected card${selected.length === 1 ? '' : 's'} exported to Anki.`);
    } catch (caught) {
      setError(caught instanceof Error ? `Anki export failed: ${caught.message}` : 'Anki export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">L</div>
        <div className="brand-copy">
          <strong>Laxu Focus</strong>
          <span>Flashcard studio</span>
        </div>
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
        <p className="field-help">Applied to every source you generate from.</p>
        <label htmlFor="document-prompt">This document</label>
        <textarea
          id="document-prompt"
          value={documentPrompt}
          onChange={(event) => setDocumentPrompt(event.target.value)}
          placeholder="Optional: emphasize a chapter, skill, question style, or level of detail."
        />
        <p className="field-help">Combined with the global prompt for this source.</p>
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
              <span>Edits are included in your export.</span>
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
                    <label htmlFor={`front-${card.id}`}>Front</label>
                    <label htmlFor={`back-${card.id}`}>Back</label>
                    <textarea id={`front-${card.id}`} value={card.front} onChange={(event) => updateCard(card.id, 'front', event.target.value)} />
                    <textarea id={`back-${card.id}`} value={card.back} onChange={(event) => updateCard(card.id, 'back', event.target.value)} />
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
