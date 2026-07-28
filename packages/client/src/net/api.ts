/** Thin REST client. Everything that is not realtime goes through here. */

import type { RatingTier } from '@wallrush/shared';

export interface Profile {
  id: string;
  name: string;
  username: string | null;
  avatar: string;
  rating: number;
  tier: RatingTier;
  guest: boolean;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  streak: number;
  bestStreak: number;
  lang: string;
  createdAt: number;
}

export interface HistoryItem {
  id: string;
  mode: string;
  ending: string;
  finishedAt: number;
  plies: number;
  rated: boolean;
  size: number;
  seats: number;
  seat: number;
  result: 'win' | 'loss' | 'draw';
  ratingBefore: number | null;
  ratingAfter: number | null;
  botLevel: string | null;
  players: { seat: number; bot: string | null; userId: string | null; name: string }[];
}

export interface Friend {
  id: string;
  name: string;
  avatar: string;
  rating: number;
  status: 'pending' | 'accepted';
  /** True when they asked us, so the list can offer an Accept button. */
  incoming: boolean;
  online: boolean;
  lastSeen: number;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  name: string;
  avatar: string;
  rating: number;
  tier: RatingTier;
  games: number;
  wins: number;
  losses: number;
  streak: number;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'wallrush.token';

export function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string) ?? '';

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.auth !== false) {
    const token = storedToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(String(body.error ?? 'request-failed'), res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; online: number }>('/api/health', { auth: false }),

  meta: () =>
    request<{ avatars: string[]; botRatings: Record<string, number>; online: number }>(
      '/api/meta',
      { auth: false },
    ),

  register: (input: {
    username: string;
    password: string;
    displayName?: string;
    lang?: string;
    guestToken?: string;
  }) =>
    request<{ token: string; user: Profile }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
      auth: false,
    }),

  login: (username: string, password: string) =>
    request<{ token: string; user: Profile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      auth: false,
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<{ user: Profile }>('/api/me'),

  updateMe: (patch: { displayName?: string; avatar?: string; lang?: string }) =>
    request<{ user: Profile }>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  history: (limit = 25, offset = 0) =>
    request<{ matches: HistoryItem[] }>(`/api/me/history?limit=${limit}&offset=${offset}`),

  leaderboard: (limit = 50) =>
    request<{ players: LeaderboardRow[] }>(`/api/leaderboard?limit=${limit}`, {
      auth: false,
    }),

  /**
   * Reports a finished offline bot game. Only the moves are sent — the server
   * replays them through the engine and derives the result itself, so there is
   * nothing useful to lie about.
   */
  reportLocalMatch: (input: {
    transcript: string;
    size: number;
    players: number;
    wallsPerPlayer: number;
    seat: number;
    botLevel: string;
    startedAt: number;
  }) =>
    request<{ id: string; result: string }>('/api/matches/local', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  friends: () => request<{ friends: Friend[] }>('/api/friends'),

  addFriend: (id: string) =>
    request<{ status: 'pending' | 'accepted' }>(`/api/friends/${id}`, { method: 'POST' }),

  removeFriend: (id: string) =>
    request<{ status: null }>(`/api/friends/${id}`, { method: 'DELETE' }),

  match: (id: string) =>
    request<{
      match: {
        id: string;
        transcript: string;
        config: Record<string, number>;
        players: { seat: number; name: string; bot: string | null }[];
        winnerSeat: number | null;
        ending: string;
        plies: number;
        finishedAt: number;
      };
    }>(`/api/match/${id}`, { auth: false }),
};
