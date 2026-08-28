import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import Home from '../app/page';

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

  test('keeps an unsupported-file error visible inside the dialog', async () => {
    render(<Home />);
    chooseFile(new File(['not a supported document'], 'archive.xyz', { type: 'application/octet-stream' }));

    const dialog = screen.getByRole('dialog', { name: 'What are you studying?' });
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('archive.xyz');
    expect(alert.textContent).toContain('not a supported document');
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
  test('sends both prompt levels, supports editing and selection, and avoids repeats when generating more', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      cards: [{
        front: 'Original question',
        back: 'Original answer',
        tags: ['concept'],
        source_hint: 'Test notes',
      }],
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
    fireEvent.click(screen.getByRole('button', { name: 'Generate candidates' }));

    await screen.findByDisplayValue('Original question');
    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstForm = firstRequest.body as FormData;
    expect(firstForm.get('globalPrompt')).toBe('Global focus');
    expect(firstForm.get('documentPrompt')).toBe('Document focus');

    const front = screen.getByLabelText('Front') as HTMLTextAreaElement;
    fireEvent.change(front, { target: { value: 'Edited question' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select card 1' }));
    expect(front.value).toBe('Edited question');
    expect((screen.getByRole('button', { name: 'Export 1 to Anki' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Generate more' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondForm = secondRequest.body as FormData;
    expect(JSON.parse(String(secondForm.get('existingFronts')))).toEqual(['Edited question']);
  });
});
