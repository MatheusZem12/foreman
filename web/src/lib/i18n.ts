import en from '../locales/en';

// Idioma e tema da pessoa, guardados neste navegador. O texto em português é a
// própria chave: t('Salvar') vira "Save" em inglês e, se faltar tradução,
// continua em português. {0}, {1}… recebem os valores: t('{0} regra(s)', n).
// Trocar o idioma recarrega a página (os textos fixos são lidos ao carregar).

export type Lang = 'pt-BR' | 'en';
export type Theme = 'system' | 'light' | 'dark';

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem storage: vale só nesta visita */
  }
}

export const lang: Lang = (() => {
  const saved = read('mx.lang');
  if (saved === 'en' || saved === 'pt-BR') return saved;
  return typeof navigator !== 'undefined' && !navigator.language?.toLowerCase().startsWith('pt') ? 'en' : 'pt-BR';
})();
export const locale = lang === 'en' ? 'en-US' : 'pt-BR';

const dict: Record<string, string> = lang === 'en' ? en : {};

export function t(text: string, ...args: (string | number | undefined | null)[]): string {
  let out = dict[text] ?? text;
  args.forEach((a, i) => {
    out = out.split(`{${i}}`).join(String(a ?? ''));
  });
  return out;
}

export function setLang(l: Lang) {
  write('mx.lang', l);
  location.reload();
}

export const theme = (): Theme => (read('mx.theme') as Theme) || 'system';

// Aplica o tema (o index.html já faz isso antes do React, para não piscar).
export function applyTheme(t: Theme = theme()) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111113' : '#f6f6f8');
}
export function setTheme(t: Theme) {
  write('mx.theme', t);
  applyTheme(t);
}
if (typeof window !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => theme() === 'system' && applyTheme());
  document.documentElement.lang = lang;
}
