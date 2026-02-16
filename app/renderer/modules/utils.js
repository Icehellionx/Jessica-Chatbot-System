/* ============================================================================
   utils.js — Text and DOM Utilities
   ========================================================================== */

export const $ = (id) => document.getElementById(id);

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

export function normalizeText(text) {
  // Accent-insensitive matching for filenames
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Minimal markdown:
 * - escapes HTML
 * - supports ***bold+italic***, **bold**, *italic* or _italic_
 * - converts newlines to <br>
 */
export function parseMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Strong+em: ***text***
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Strong: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Em: *text* or _text_ (avoid matching inside words with simple boundaries)
  html = html.replace(/(^|[\s(])(\*|_)(.+?)\2(?=[\s).,!?:;]|$)/g, '$1<em>$3</em>');

  return html.replace(/\n/g, '<br>');
}
