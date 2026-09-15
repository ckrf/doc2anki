import { describe, expect, test } from 'vitest';

import { createAnkiTextBackup, toAnkiHtml } from '../lib/anki-format';

describe('Anki field formatting', () => {
  test('converts dollar-delimited LaTeX to Anki MathJax delimiters', () => {
    expect(toAnkiHtml('Energy is $E=mc^2$.\n\n$$F = ma$$')).toBe(
      'Energy is \\(E=mc^2\\).<br><br>\\[F = ma\\]',
    );
  });

  test('preserves existing Anki delimiters and escapes HTML-sensitive math', () => {
    expect(toAnkiHtml('Use \\(x < y\\) and \\[a & b\\].')).toBe(
      'Use \\(x &lt; y\\) and \\[a &amp; b\\].',
    );
  });

  test('creates a two-column HTML backup without a tags column', () => {
    const backup = createAnkiTextBackup([{ front: 'What is $x$?', back: '$$x=2$$' }]);
    expect(backup).toContain('#columns:Front\tBack');
    expect(backup).toContain('What is \\(x\\)?\t\\[x=2\\]');
    expect(backup).not.toContain('Tags');
  });
});
