const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function plainTextToHtml(value: string) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/**
 * Converts common LLM math delimiters to the MathJax delimiters supported by
 * Anki, while escaping ordinary text so angle brackets and ampersands survive
 * the HTML field format.
 */
export function toAnkiHtml(value: string) {
  const mathPattern = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|(?<!\\)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$/g;
  let html = '';
  let cursor = 0;

  for (const match of value.matchAll(mathPattern)) {
    const index = match.index ?? 0;
    html += plainTextToHtml(value.slice(cursor, index));

    const expression = match[0];
    if (expression.startsWith('$$')) {
      html += `\\[${escapeHtml(expression.slice(2, -2).trim())}\\]`;
    } else if (expression.startsWith('$')) {
      html += `\\(${escapeHtml(expression.slice(1, -1).trim())}\\)`;
    } else {
      html += escapeHtml(expression);
    }
    cursor = index + expression.length;
  }

  html += plainTextToHtml(value.slice(cursor));
  return html;
}

export function createAnkiTextBackup(cards: Array<{ front: string; back: string }>) {
  const cleanCell = (value: string) => value.replace(/\t/g, ' ');
  const rows = cards.map((card) => [
    cleanCell(toAnkiHtml(card.front.trim())),
    cleanCell(toAnkiHtml(card.back.trim())),
  ].join('\t'));

  return ['#separator:tab', '#html:true', '#columns:Front\tBack', ...rows].join('\n');
}
