import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import Home from '../app/page';

const apkgSaveMock = vi.hoisted(() => vi.fn());

vi.mock('apkg-browser-builder', () => {
  class Collection { addDeck() {} }
  class Deck { addCard() {} }
  class Card {
    setDue() {}
    getNote() { return { setTags() {} }; }
  }
  return {
    default: class ApkgBuilder { save = apkgSaveMock; },
    Collection,
    Deck,
    Card,
  };
});

function sourceFileInput() {
  return document.querySelector('#source-file') as HTMLInputElement;
}

function chooseFile(file?: File) {
  fireEvent.change(sourceFileInput(), { target: { files: file ? [file] : [] } });
}

describe('source dialog', () => {
  test('starts with an accessible file chooser', () => {
    render(<Home />);

    const dialog = screen.getByRole('dialog', { name: 'What are you studying?' });
    expect(within(dialog).getByText('Choose a file')).toBeTruthy();
    expect(sourceFileInput().accept).toContain('.pdf');
  });

  test('accepts a small PDF and makes it the current source', async () => {
    render(<Home />);
    chooseFile(new File(['%PDF-1.7\nsmall test'], 'chapter.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'chapter.pdf' })).toBeTruthy();
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
  });

  test('recognizes a PDF signature when the browser supplies no useful extension or MIME type', async () => {
    render(<Home />);
    chooseFile(new File(['%PDF-1.7\nsignature test'], 'download', { type: 'application/octet-stream' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'download.pdf' })).toBeTruthy();
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
  });

  test('explains when a drop or picker event contains no file', async () => {
    render(<Home />);
    chooseFile();

    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain('No local file was received');
  });

  test('keeps short pasted-text validation visible inside the dialog', async () => {
    render(<Home />);
    fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    fireEvent.change(screen.getByLabelText('Notes or source text'), { target: { value: 'Too short.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this text' }));

    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toContain('Paste at least a short paragraph');
  });
});

describe('candidate review', () => {
  test('turns a plain-text 413 response into a clear upload error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Payload Too Large', { status: 413 })));
    render(<Home />);

    fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    fireEvent.change(screen.getByLabelText('Notes or source text'), {
      target: { value: 'This is a sufficiently long source paragraph for exercising response error handling safely.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidates' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('server rejected this upload');
    expect(alert.textContent).not.toContain('Unexpected token');
  });

  test('sends both prompt levels, supports editing and selection, and avoids repeats when generating more', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sourceTitle: 'Test notes',
      cards: [{
        front: 'Original question',
        back: 'Original answer',
        tags: ['concept'],
        source_hint: 'Test notes',
      }],
      usage: {
        model: 'gpt-5.6-terra',
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 100,
        estimatedCostUsd: 0.0032,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Home />);

    fireEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    fireEvent.change(screen.getByLabelText('Source title'), { target: { value: 'Test notes' } });
    fireEvent.change(screen.getByLabelText('Notes or source text'), {
      target: { value: 'This is a sufficiently long source paragraph containing material for a useful flashcard test.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this text' }));

    fireEvent.change(screen.getByLabelText('Global study prompt'), { target: { value: 'Global focus' } });
    fireEvent.change(screen.getByLabelText('This document'), { target: { value: 'Document focus' } });
    fireEvent.change(screen.getByLabelText('Generation model'), { target: { value: 'gpt-5.6-terra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidates' }));

    await screen.findByDisplayValue('Original question');
    expect(screen.queryByLabelText('Back')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show and edit answer' }));
    const back = screen.getByLabelText('Back') as HTMLTextAreaElement;
    fireEvent.change(back, { target: { value: 'Edited answer' } });
    expect(back.value).toBe('Edited answer');
    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstForm = firstRequest.body as FormData;
    expect(firstForm.get('globalPrompt')).toBe('Global focus');
    expect(firstForm.get('documentPrompt')).toBe('Document focus');
    expect(firstForm.get('model')).toBe('gpt-5.6-terra');
    expect(localStorage.getItem('laxu-focus.model.v1')).toBe('gpt-5.6-terra');

    const front = screen.getByLabelText('Front') as HTMLTextAreaElement;
    fireEvent.change(front, { target: { value: 'Edited question' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select card 1' }));
    expect(front.value).toBe('Edited question');
    expect((screen.getByRole('button', { name: 'Export 1 to Anki' }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => {
      const savedDraft = JSON.parse(String(localStorage.getItem('laxu-focus.review-draft.v1')));
      expect(savedDraft.cards[0]).toMatchObject({ front: 'Edited question', back: 'Edited answer', selected: true });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Generate more' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondForm = secondRequest.body as FormData;
    expect(JSON.parse(String(secondForm.get('existingFronts')))).toEqual(['Edited question']);
  });

  test('saves the global prompt and restores it in a later session', async () => {
    const firstSession = render(<Home />);
    const prompt = screen.getByLabelText('Global study prompt') as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: 'Saved study preference' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save global prompt' }));
    expect(localStorage.getItem('laxu-focus.global-prompt.v1')).toBe('Saved study preference');

    firstSession.unmount();
    render(<Home />);
    await waitFor(() => expect((screen.getByLabelText('Global study prompt') as HTMLTextAreaElement).value).toBe('Saved study preference'));
  });

  test('replaces an opaque PDF identifier with the title inferred during generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sourceTitle: 'Developmental Biology — Chapter 5',
      cards: [{ front: 'Question', back: 'Answer', tags: ['biology'], source_hint: 'Chapter 5' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(<Home />);
    chooseFile(new File(
      ['%PDF-1.7\nopaque filename test'],
      '1IUr9u-7JZhDX7lb6tSBqczHjGU1AcrDZ',
      { type: 'application/octet-stream' },
    ));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Untitled PDF' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidates' }));
    expect(await screen.findByRole('heading', { name: 'Developmental Biology — Chapter 5.pdf' })).toBeTruthy();
  });

  test('restores an edited review draft after a refresh and can export it without another fetch', async () => {
    apkgSaveMock.mockReset().mockResolvedValue(undefined);
    localStorage.setItem('laxu-focus.review-draft.v1', JSON.stringify({
      source: { kind: 'file', name: 'Saved chapter.pdf', detail: 'Saved PDF' },
      documentPrompt: 'Saved document focus',
      cards: [{
        id: 'saved-card',
        front: 'Saved edited question',
        back: 'Saved edited answer',
        tags: ['saved'],
        sourceHint: 'Saved chapter',
        selected: true,
        revealed: false,
        batch: 1,
      }],
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);
    await screen.findByDisplayValue('Saved edited question');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/saved candidate restored/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Export 1 to Anki' }));
    await waitFor(() => expect(apkgSaveMock).toHaveBeenCalledWith('Saved chapter.apkg'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
