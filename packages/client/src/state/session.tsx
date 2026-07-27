/**
 * Session.
 *
 * Accounts are optional by design: you can play the whole game without one.
 * The server hands every connection a guest identity, and registering later
 * upgrades that same identity so a guest's games are not thrown away.
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

import { api, ApiError, storeToken, storedToken, type Profile } from '../net/api.js';

interface SessionValue {
  profile: Profile | null;
  loading: boolean;
  signedIn: boolean;
  signIn(username: string, password: string): Promise<void>;
  signUp(input: { username: string; password: string; displayName?: string; lang?: string }): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  update(patch: { displayName?: string; avatar?: string; lang?: string }): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!storedToken()) {
      setProfile(null);
      setLoading(false);
      return;
    }
    try {
      const { user } = await api.me();
      setProfile(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) storeToken(null);
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const { token, user } = await api.login(username, password);
    storeToken(token);
    setProfile(user);
  }, []);

  const signUp = useCallback(
    async (input: { username: string; password: string; displayName?: string; lang?: string }) => {
      const { token, user } = await api.register({
        ...input,
        guestToken: storedToken() ?? undefined,
      });
      storeToken(token);
      setProfile(user);
    },
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the token is being discarded anyway */
    }
    storeToken(null);
    setProfile(null);
  }, []);

  const update = useCallback(
    async (patch: { displayName?: string; avatar?: string; lang?: string }) => {
      const { user } = await api.updateMe(patch);
      setProfile(user);
    },
    [],
  );

  const value = useMemo(
    () => ({
      profile,
      loading,
      signedIn: profile !== null && !profile.guest,
      signIn,
      signUp,
      signOut,
      refresh,
      update,
    }),
    [profile, loading, signIn, signUp, signOut, refresh, update],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
