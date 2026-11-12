import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

// Links written by people or by the agent open in another tab and tell the destination
// nothing about this page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof Element && node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Parsing and sanitizing is the expensive part of an issue page (every comment, every
// line of the agent's log). The same text always gives the same HTML, so it is kept:
// re-rendering, switching tabs or reopening a log costs nothing.
const cache = new Map<string, string>();
const MAX_ENTRIES = 500;
const MAX_CACHED_LENGTH = 20_000;

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ['target'] });
  if (text.length <= MAX_CACHED_LENGTH) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(text, html);
  }
  return html;
}
