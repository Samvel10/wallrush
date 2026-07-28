/**
 * The URL half of the router, kept apart from the React half.
 *
 * Not for tidiness: these are pure functions and this file has no JSX, so the
 * test runner can load it directly. Two bugs in this project came from a game
 * mode quietly failing to survive a round trip through somewhere, and a URL is
 * one of the places that happens.
 */

import type { GameMode } from '@wallrush/shared';

export type Route =
  | { name: 'home' }
  | { name: 'bots' }
  | { name: 'local'; mode?: GameMode }
  | { name: 'play-bot'; level: string; seats?: 2 | 4; mode?: GameMode }
  | { name: 'play-local'; mode?: GameMode }
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
    case 'play-bot': {
      const suffix = route.mode === 'race' ? '/race' : route.seats === 4 ? '/4' : '';
      return `#/bot/${route.level}${suffix}`;
    }
    case 'local':
    case 'play-local':
      return route.mode === 'race' ? '#/local/race' : '#/local';
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
        mode: parts[2] === 'race' ? 'race' : 'duel',
      };
    case 'local':
      return { name: 'local', mode: parts[1] === 'race' ? 'race' : 'duel' };
    case 'play-local':
      return { name: 'play-local', mode: parts[1] === 'race' ? 'race' : 'duel' };
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


