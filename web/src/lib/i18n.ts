import ptBR from '../locales/pt-BR';

// The person's language and theme, kept in this browser. The English text is the key
// itself: t('Save') becomes "Salvar" in Portuguese and, if a translation is missing,
// stays in English. {0}, {1}… receive the values: t('{0} rule(s)', n).
// Switching the language reloads the page (fixed texts are read on load).

export type Lang = 'pt-BR' | 'en';
export type Theme = 'system' | 'light' | 'dark';

function read(key: string) {
  try {
    // Preferences saved before the rename used the `foreman.` prefix: read them once.
    const legacy = key.replace(/^foreman\./, 'foreman.');
    const value = localStorage.getItem(key) ?? localStorage.getItem(legacy);
    if (value !== null && localStorage.getItem(key) === null) localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage: it only lasts this visit */
  }
}

export const lang: Lang = (() => {
  const saved = read('foreman.lang');
  if (saved === 'en' || saved === 'pt-BR') return saved;
  return typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('pt') ? 'en' : 'pt-BR';
})();
export const locale = lang === 'en' ? 'en-US' : 'pt-BR';

const dict: Record<string, string> = lang === 'pt-BR' ? ptBR : {};

export function t(text: string, ...args: (string | number | undefined | null)[]): string {
  let out = dict[text] ?? text;
  args.forEach((a, i) => {
    out = out.split(`{${i}}`).join(String(a ?? ''));
  });
  return out;
}

export function setLang(l: Lang) {
  write('foreman.lang', l);
  location.reload();
}

export const theme = (): Theme => (read('foreman.theme') as Theme) || 'system';

// Applies the theme (index.html already does it before React, so it doesn't flicker).
export function applyTheme(t: Theme = theme()) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111113' : '#f6f6f8');
}
export function setTheme(t: Theme) {
  write('foreman.theme', t);
  applyTheme(t);
}
if (typeof window !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => theme() === 'system' && applyTheme());
  document.documentElement.lang = lang;
}
