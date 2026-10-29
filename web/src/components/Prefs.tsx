import { useState } from 'react';
import clsx from 'clsx';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { lang, setLang, setTheme, t, theme, type Lang, type Theme } from '../lib/i18n';

// Tema (sistema, claro, escuro) e idioma (pt-BR, en). Ficam neste navegador.

const THEMES: { id: Theme; icon: typeof Sun; label: () => string }[] = [
  { id: 'system', icon: Monitor, label: () => t('System') },
  { id: 'light', icon: Sun, label: () => t('Light') },
  { id: 'dark', icon: Moon, label: () => t('Dark') }
];
const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'pt-BR', label: 'Português (Brasil)', short: 'PT' },
  { id: 'en', label: 'English', short: 'EN' }
];

function useTheme() {
  const [th, set] = useState<Theme>(theme);
  return [th, (v: Theme) => { setTheme(v); set(v); }] as const;
}

// Two small buttons: toggles the theme and switches the language.
export function PrefsQuick({ className }: { className?: string }) {
  const [th, set] = useTheme();
  const cur = THEMES.find((x) => x.id === th) ?? THEMES[0];
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  const other = LANGS.find((x) => x.id !== lang)!;
  const btn = 'inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-mute transition hover:bg-white/[0.06] hover:text-fg';
  return (
    <div className={clsx('flex items-center gap-0.5', className)}>
      <button type="button" className={btn} onClick={() => set(next.id)} title={t('Theme: {0} (click for {1})', cur.label(), next.label().toLowerCase())}>
        <cur.icon className="size-3.5" /> <span>{cur.label()}</span>
      </button>
      <button type="button" className={btn} onClick={() => setLang(other.id)} title={other.label}>
        <Languages className="size-3.5" /> {LANGS.find((x) => x.id === lang)!.short}
      </button>
    </div>
  );
}

// The "My account" section.
export function Appearance() {
  const [th, set] = useTheme();
  return (
    <section>
      <h2 className="mb-1 font-semibold">{t('Appearance & language')}</h2>
      <p className="mb-3 text-xs text-mute">{t('Apply to this browser.')}</p>
      <div className="grid gap-4 surface p-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-dim">{t('Theme')}</span>
          <div className="flex gap-1 rounded-xl border border-line p-1">
            {THEMES.map((x) => (
              <button key={x.id} type="button" onClick={() => set(x.id)}
                className={clsx('flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] transition', th === x.id ? 'bg-accent/15 font-medium text-fg' : 'text-dim hover:bg-white/[0.04]')}>
                <x.icon className="size-3.5" /> {x.label()}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-dim">{t('Language')}</span>
          <select className="field-input" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>
    </section>
  );
}
