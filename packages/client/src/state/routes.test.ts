import { strict as assert } from 'node:assert';
import test from 'node:test';

import { parseHash, routeToHash, type Route } from './routes.ts';

/**
 * A URL is a place a game mode goes to die.
 *
 * Twice in this project a mode survived everywhere except one round trip —
 * once through the match report, once through the board it was replayed on.
 * These check the trip a shared link actually takes: route → hash → route.
 */
const ROUTES: Route[] = [
  { name: 'home' },
  { name: 'bots' },
  { name: 'lobby' },
  { name: 'create' },
  { name: 'quick' },
  { name: 'leaderboard' },
  { name: 'profile' },
  { name: 'rules' },
  { name: 'auth', mode: 'in' },
  { name: 'auth', mode: 'up' },
  { name: 'room', code: 'AB12C' },
  { name: 'replay', id: '73fea6d8-b798-4e66-aca4-a5d171fb0669' },
  { name: 'play-bot', level: 'hard', seats: 2, mode: 'duel' },
  { name: 'play-bot', level: 'master', seats: 4, mode: 'duel' },
  { name: 'play-bot', level: 'medium', seats: 2, mode: 'race' },
  { name: 'play-local', mode: 'duel' },
  { name: 'play-local', mode: 'race' },
];

test('every route survives the trip through a link', () => {
  for (const route of ROUTES) {
    const back = parseHash(routeToHash(route));
    assert.equal(back.name === 'local' ? 'play-local' : back.name, route.name, routeToHash(route));
    for (const [key, value] of Object.entries(route)) {
      if (key === 'name') continue;
      assert.equal(
        (back as unknown as Record<string, unknown>)[key],
        value,
        `${key} was lost by ${routeToHash(route)}`,
      );
    }
  }
});

test('the race is named in the link, so it can be shared', () => {
  assert.equal(routeToHash({ name: 'play-bot', level: 'hard', mode: 'race' }), '#/bot/hard/race');
  assert.equal(routeToHash({ name: 'play-local', mode: 'race' }), '#/local/race');
  assert.equal(parseHash('#/bot/hard/race').name, 'play-bot');
  assert.equal((parseHash('#/bot/hard/race') as { mode?: string }).mode, 'race');
  assert.equal((parseHash('#/local/race') as { mode?: string }).mode, 'race');
});

test('a four-seat bot game and a race are not confusable', () => {
  // Both live in the same URL slot, so the wrong one would be silent.
  assert.equal(routeToHash({ name: 'play-bot', level: 'easy', seats: 4 }), '#/bot/easy/4');
  const four = parseHash('#/bot/easy/4') as { seats?: number; mode?: string };
  assert.equal(four.seats, 4);
  assert.equal(four.mode, 'duel');
  const race = parseHash('#/bot/easy/race') as { seats?: number; mode?: string };
  assert.equal(race.mode, 'race');
});

test('a half-written link still lands somewhere useful', () => {
  for (const hash of ['', '#', '#/', '#/nonsense', '#/room', '#//', '#/bot']) {
    assert.ok(parseHash(hash).name, `${hash} produced no route`);
  }
  assert.equal(parseHash('#/nonsense').name, 'home');
  assert.equal(parseHash('').name, 'home');

  // These two are deliberate and worth pinning down: somebody who followed a
  // room link with the code lost wanted a room, so show them the rooms; and a
  // replay link without an id belongs with the rest of your games.
  assert.equal(parseHash('#/room').name, 'lobby');
  assert.equal(parseHash('#/replay').name, 'profile');

  // A bot link with nothing after it is still a playable game.
  const bare = parseHash('#/bot') as { level?: string; mode?: string };
  assert.equal(bare.level, 'medium');
  assert.equal(bare.mode, 'duel');
});
