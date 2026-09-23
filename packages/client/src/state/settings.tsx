/** Local preferences: theme, sound, board helpers. Persisted to localStorage. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { wantsMoveConfirmation } from './input-preferences.js';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  sound: boolean;
  haptics: boolean;
  animations: boolean;
  showCoordinates: boolean;
  showPath: boolean;
  /** Optional two-tap confirmation; all devices default to a single tap. */
  confirmMoves: boolean;
  /**
   * Whether a shared-device game turns the board round between turns.
   *
   * Off by default: two people playing on one device usually sit across from
   * each other, and a board that spins on every move is disorienting for both
   * of them. With it off, the player sitting opposite gets their own controls,
   * the right way up for their side of the table.
   */
  rotateBoard: boolean;
}

const STORAGE_KEY = 'wallrush.settings';

function defaults(): Settings {
  return {
    theme: 'auto',
    sound: true,
    haptics: true,
    animations: true,
    showCoordinates: false,
    showPath: false,
    confirmMoves: false,
    rotateBoard: false,
  };
}

function load(): Settings {
  const base = defaults();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Settings> & { inputVersion?: number };
    // Old touch defaults cannot be distinguished from an explicit choice.
    // Migrate once to single tap; subsequent opt-ins remain persisted.
    return { ...base, ...parsed, confirmMoves: wantsMoveConfirmation(parsed) };
  } catch {
    return base;
  }
}

interface SettingsValue {
  settings: Settings;
  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  reset(): void;
  /** Effective theme after resolving `auto`. */
  resolvedTheme: 'light' | 'dark';
}

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState<Settings>(() => load());
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    settings.theme === 'auto' ? (systemDark ? 'dark' : 'light') : settings.theme;

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
    root.classList.toggle('no-motion', !settings.animations);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#0d101d' : '#f7f8fb');
  }, [settings.theme, settings.animations, resolvedTheme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, inputVersion: 2 }));
    } catch {
      /* storage may be unavailable in private mode */
    }
  }, [settings]);

  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(defaults()), []);

  const value = useMemo(
    () => ({ settings, set, reset, resolvedTheme }),
    [settings, set, reset, resolvedTheme],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
