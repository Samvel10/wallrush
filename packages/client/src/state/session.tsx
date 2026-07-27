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
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api, ApiError, storeToken, storedToken, type Profile } from '../net/api.js';
import { connection } from '../net/socket.js';

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
  const knownId = useRef<string | null>(null);
  /** Guards against the boot refresh and the welcome message both fetching. */
  const fetching = useRef(false);

  const refresh = useCallback(async () => {
    if (!storedToken()) {
      setProfile(null);
      setLoading(false);
      return;
    }
    fetching.current = true;
    try {
      const { user } = await api.me();
      knownId.current = user.id;
      setProfile(user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) storeToken(null);
      setProfile(null);
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The socket is the source of truth for who you are while you are a guest:
  // the server hands out an identity (and a token to keep it) on connect, and
  // without adopting it the client cannot tell which seat at a table is its own.
  //
  // Reconnects re-send `welcome`, so the identity is only re-read from the API
  // when it actually changed — otherwise every dropped socket would cost a
  // needless round trip.
  useEffect(
    () =>
      connection.onMessage((msg) => {
        if (msg.t !== 'welcome') return;
        if (msg.token) storeToken(msg.token);
        if (knownId.current === msg.user.id) return;
        knownId.current = msg.user.id;
        setProfile((prev) => {
          if (prev && !prev.guest) return prev;
          if (prev && prev.id === msg.user.id) return prev;
          return {
            id: msg.user.id,
            name: msg.user.name,
            username: null,
            avatar: msg.user.avatar,
            rating: msg.user.rating,
            tier: 'bronze',
            guest: msg.user.guest,
            games: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            streak: 0,
            bestStreak: 0,
            lang: 'hy',
            createdAt: Date.now(),
          };
        });
        setLoading(false);
        // Fill in the real statistics for the identity we just adopted — unless
        // the boot-time refresh is already on its way for the same account.
        if (fetching.current) return;
        fetching.current = true;
        void api
          .me()
          .then(({ user }) => setProfile(user))
          .catch(() => undefined)
          .finally(() => {
            fetching.current = false;
          });
      }),
    [],
  );

  const signIn = useCallback(async (username: string, password: string) => {
    const { token, user } = await api.login(username, password);
    storeToken(token);
    knownId.current = user.id;
    setProfile(user);
  }, []);

  const signUp = useCallback(
    async (input: { username: string; password: string; displayName?: string; lang?: string }) => {
      const { token, user } = await api.register({
        ...input,
        guestToken: storedToken() ?? undefined,
      });
      storeToken(token);
      knownId.current = user.id;
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
    knownId.current = null;
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
