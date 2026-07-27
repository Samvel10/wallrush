/**
 * A tiny hash router.
 *
 * Hash routes mean the built client is a single static file that works from any
 * path, any CDN, and inside a service-worker cache, with no server rewrite
 * rules to get wrong. Deep links like `#/room/AB12C` still work when shared.
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

export type Route =
  | { name: 'home' }
  | { name: 'bots' }
  | { name: 'local' }
  | { name: 'play-bot'; level: string; seats?: 2 | 4 }
  | { name: 'play-local' }
  | { name: 'lobby' }
  | { name: 'create' }
  | { name: 'room'; code: string }
  | { name: 'quick' }
  | { name: 'leaderboard' }
  | { name: 'profile' }
  | { name: 'auth'; mode: 'in' | 'up' }
  | { name: 'rules' }
  | { name: 'settings' }
  | { name: 'replay'; id: string };

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'play-bot':
      return route.seats === 4 ? `#/bot/${route.level}/4` : `#/bot/${route.level}`;
    case 'room':
      return `#/room/${route.code}`;
    case 'auth':
      return `#/auth/${route.mode}`;
    case 'replay':
      return `#/replay/${route.id}`;
    default:
      return `#/${route.name}`;
  }
}

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  if (!clean) return { name: 'home' };
  const parts = clean.split('/');
  switch (parts[0]) {
    case 'bots':
      return { name: 'bots' };
    case 'bot':
      return {
        name: 'play-bot',
        level: parts[1] ?? 'medium',
        seats: parts[2] === '4' ? 4 : 2,
      };
    case 'local':
      return { name: 'local' };
    case 'play-local':
      return { name: 'play-local' };
    case 'lobby':
      return { name: 'lobby' };
    case 'create':
      return { name: 'create' };
    case 'quick':
      return { name: 'quick' };
    case 'room':
      return parts[1] ? { name: 'room', code: parts[1].toUpperCase() } : { name: 'lobby' };
    case 'leaderboard':
      return { name: 'leaderboard' };
    case 'profile':
      return { name: 'profile' };
    case 'settings':
      return { name: 'settings' };
    case 'rules':
      return { name: 'rules' };
    case 'auth':
      return { name: 'auth', mode: parts[1] === 'up' ? 'up' : 'in' };
    case 'replay':
      return parts[1] ? { name: 'replay', id: parts[1] } : { name: 'profile' };
    default:
      return { name: 'home' };
  }
}

interface RouterValue {
  route: Route;
  go(route: Route, replace?: boolean): void;
  back(): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }): ReactNode {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Route, replace = false) => {
    const hash = routeToHash(next);
    if (window.location.hash === hash) {
      setRoute(next);
      return;
    }
    if (replace) window.history.replaceState(null, '', hash);
    else window.location.hash = hash;
    setRoute(next);
  }, []);

  const back = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else go({ name: 'home' });
  }, [go]);

  const value = useMemo(() => ({ route, go, back }), [route, go, back]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter must be used inside <RouterProvider>');
  return ctx;
}
