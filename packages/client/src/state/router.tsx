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

import { parseHash, routeToHash, type Route } from './routes.js';

export { parseHash, routeToHash, type Route };

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
