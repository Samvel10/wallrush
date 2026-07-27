#!/usr/bin/env node
/**
 * Soak test.
 *
 * Runs many concurrent games against a live server and reports latency, memory
 * and whether anything leaked. Not part of `npm test` — it takes minutes and
 * needs a server — but it is the check that answers "will this hold up".
 *
 *   node scripts/soak.mjs --games 60 --url http://127.0.0.1:8791
 */

import { WebSocket } from 'ws';

import { Game } from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const URL_BASE = opt('url', 'http://127.0.0.1:8791');
const GAMES = Number(opt('games', 40));
const SIZE = Number(opt('size', 5));
const WS_BASE = URL_BASE.replace(/^http/, 'ws') + '/ws';

const latencies = [];
let movesPlayed = 0;
let finished = 0;
let failed = 0;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_BASE);
    const inbox = [];
    const waiters = [];
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.match(msg));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else inbox.push(msg);
    });
    socket.on('error', reject);
    const client = {
      socket,
      send: (m) => socket.send(JSON.stringify(m)),
      wait(type, filter, timeout = 20000) {
        const match = (m) => m.t === type && (!filter || filter(m));
        const i = inbox.findIndex(match);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
          waiters.push({ match, resolve: res, timer });
        });
      },
      close: () => socket.close(),
    };
    socket.on('open', () => resolve(client));
  });
}

/**
 * The legal step that shortens the route most. Uses the real engine rather than
 * a hand-rolled approximation: when the two pawns meet head-on the rules call
 * for a jump, and a naive "walk toward the goal" driver stalls there.
 */
function bestStep(state, seat) {
  const game = Game.fromState(state);
  const player = game.players[seat];
  let best = null;
  let bestDist = Infinity;
  for (const to of game.pawnMoves(seat)) {
    const d = game.distanceToGoal(to.r, to.c, player.side);
    if (d >= 0 && d < bestDist) {
      bestDist = d;
      best = to;
    }
  }
  return best;
}

async function playOne(index) {
  const a = await connect();
  const b = await connect();
  await a.wait('welcome');
  await b.wait('welcome');
  try {
    a.send({
      t: 'room.create',
      visibility: 'private',
      config: { size: SIZE, players: 2, wallsPerPlayer: 0, clockMs: 0, moveTimeoutMs: 0 },
      rated: false,
    });
    const room = await a.wait('room');
    b.send({ t: 'room.join', code: room.room.code });
    await b.wait('room', (m) => m.room.seats[1].user !== null);
    a.send({ t: 'room.ready', ready: true });
    b.send({ t: 'room.ready', ready: true });
    const start = await a.wait('game.start');
    await b.wait('game.start');

    const clients = [a, b];
    let state = start.state;
    for (let step = 0; step < 200; step++) {
      if (state.winner !== null || state.ending) break;
      const seat = state.turn;
      const to = bestStep(state, seat);
      if (!to) throw new Error(`no legal move at ply ${state.ply}`);
      const sent = Date.now();
      clients[seat].send({ t: 'game.move', move: { kind: 0, to }, ply: state.ply });
      const accepted = await a.wait('game.move', (m) => m.by === seat, 15000);
      latencies.push(Date.now() - sent);
      movesPlayed += 1;
      state = accepted.state;
    }
    await a.wait('game.over', undefined, 15000);
    finished += 1;
  } catch (err) {
    failed += 1;
    process.stderr.write(`game ${index} failed: ${String(err)}\n`);
  } finally {
    a.close();
    b.close();
  }
}

const started = Date.now();
const before = await (await fetch(`${URL_BASE}/api/health`)).json();
process.stdout.write(`start: ${JSON.stringify(before)}\n`);

await Promise.all(Array.from({ length: GAMES }, (_, i) => playOne(i)));

// Give the server a moment to reap the finished rooms.
await new Promise((r) => setTimeout(r, 3000));
const after = await (await fetch(`${URL_BASE}/api/health`)).json();

latencies.sort((x, y) => x - y);
const pick = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
process.stdout.write(
  [
    `games:      ${finished} finished, ${failed} failed`,
    `moves:      ${movesPlayed}`,
    `wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`,
    `latency:    p50 ${pick(0.5)}ms  p95 ${pick(0.95)}ms  p99 ${pick(0.99)}ms  max ${latencies.at(-1)}ms`,
    `rooms:      ${before.rooms} before -> ${after.rooms} after`,
    `online:     ${before.online} before -> ${after.online} after`,
    `matches:    ${before.matches} -> ${after.matches}`,
  ].join('\n') + '\n',
);

process.exit(failed > 0 || after.rooms > before.rooms ? 1 : 0);
