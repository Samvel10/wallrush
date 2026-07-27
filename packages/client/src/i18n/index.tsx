/**
 * WallRush — internationalisation.
 *
 * Three languages, one dictionary shape. The Armenian file is the source of
 * truth: `Dictionary` is derived from it, so a missing key in Russian or
 * English is a compile error rather than a blank label in production.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { hy, type Dictionary } from './hy.js';
import { ru } from './ru.js';
import { en } from './en.js';

export type Lang = 'hy' | 'ru' | 'en';

export const LANGS: Lang[] = ['hy', 'ru', 'en'];

const DICTIONARIES: Record<Lang, Dictionary> = { hy, ru, en };

const STORAGE_KEY = 'wallrush.lang';

export function detectLanguage(): Lang {
  if (typeof window === 'undefined') return 'hy';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'hy' || stored === 'ru' || stored === 'en') return stored;
  const candidates = navigator.languages ?? [navigator.language];
  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('hy')) return 'hy';
    if (tag.startsWith('ru')) return 'ru';
    if (tag.startsWith('en')) return 'en';
  }
  // Armenian is the project's home language, so it is the default.
  return 'hy';
}

interface I18nValue {
  lang: Lang;
  t: Dictionary;
  setLang(lang: Lang): void;
  /** Interpolate `{name}`-style placeholders. */
  f(template: string, vars: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [lang, setLangState] = useState<Lang>(() => detectLanguage());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private browsing — keep going with the in-memory value */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = DICTIONARIES[lang].meta.dir;
    document.title = `${DICTIONARIES[lang].app.title} — ${DICTIONARIES[lang].app.tagline}`;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', DICTIONARIES[lang].app.description);
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      t: DICTIONARIES[lang],
      setLang,
      f: (template, vars) =>
        template.replace(/\{(\w+)\}/g, (_, key: string) =>
          key in vars ? String(vars[key]) : `{${key}}`,
        ),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

export function dictionaryFor(lang: Lang): Dictionary {
  return DICTIONARIES[lang];
}

export type { Dictionary };
