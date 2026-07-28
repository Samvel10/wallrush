#!/usr/bin/env node
/**
 * A scriptable opponent, for driving the UI by hand without a second browser.
 *
 *   node scripts/opponent.mjs --code AB12C --do draw
 *   node scripts/opponent.mjs --code AB12C --token <jwt> --do play --moves 20
 *   node scripts/opponent.mjs --code AB12C --do play --moves 3
 *
 * Actions: play (make N moves), draw (offer a draw), resign, chat, leave.
 */

import { WebSocket } from 'ws';

import { Game } from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const URL_BASE = opt('url', 'http://127.0.0.1:8791');
const CODE = opt('code', '');
const ACTION = opt('do', 'play');
const COUNT = Number(opt('moves', 1));
const TEXT = opt('text', 'բարև');

if (!CODE) {
  process.stderr.write('need --code\n');
  process.exit(1);
}

const TOKEN = opt('token', '');
const socket = new WebSocket(
  URL_BASE.replace('http', 'ws') + '/ws' + (TOKEN ? `?token=${TOKEN}` : ''),
);
const inbox = [];
const waiters = [];
socket.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  const i = waiters.findIndex((w) => w.match(m));
  if (i >= 0) {
    const [w] = waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(m);
  } else inbox.push(m);
});

const send = (m) => socket.send(JSON.stringify(m));
/** Generous by default: a human driving the other side is slow. */
const WAIT_MS = Number(opt('timeout', 120000));
const wait = (type, filter, timeout = WAIT_MS) =>
  new Promise((res, rej) => {
    const match = (m) => m.t === type && (!filter || filter(m));
    const i = inbox.findIndex(match);
    if (i >= 0) return res(inbox.splice(i, 1)[0]);
    const timer = setTimeout(() => rej(new Error(`timeout ${type}`)), timeout);
    waiters.push({ match, resolve: res, timer });
  });

await new Promise((r) => socket.on('open', r));
await wait('welcome');
send({ t: 'room.join', code: CODE });
// The server re-attaches a returning player to whatever room they were last
// in, so the first `room` message may be about a different table. Wait for
// the one we actually asked for.
const room = await wait('room', (m) => m.room.code === CODE);
process.stdout.write(`joined ${room.room.code}\n`);
send({ t: 'room.ready', ready: true });

const bestStep = (state, seat) => {
  const g = Game.fromState(state);
  const p = g.players[seat];
  let to = null;
  let d = Infinity;
  for (const m of g.pawnMoves(seat)) {
    const x = g.distanceToGoal(m.r, m.c, p.side);
    if (x >= 0 && x < d) {
      d = x;
      to = m;
    }
  }
  return { kind: 0, to };
};

if (ACTION === 'play' || ACTION === 'draw' || ACTION === 'resign' || ACTION === 'chat') {
  const start = await wait('game.start');
  const seat = start.seat;
  process.stdout.write(`playing seat ${seat}\n`);
  let state = start.state;

  if (ACTION === 'chat') {
    send({ t: 'chat', text: TEXT });
    process.stdout.write('chat sent\n');
  } else if (ACTION === 'draw') {
    send({ t: 'game.drawOffer' });
    process.stdout.write('draw offered\n');
  } else if (ACTION === 'resign') {
    send({ t: 'game.resign' });
    process.stdout.write('resigned\n');
  } else {
    for (let i = 0; i < COUNT; i++) {
      while (state.turn !== seat) {
        const m = await wait('game.move');
        state = m.state;
        if (state.winner !== null) break;
      }
      if (state.winner !== null) break;
      send({ t: 'game.move', move: bestStep(state, seat), ply: state.ply });
      const echo = await wait('game.move', (m) => m.by === seat);
      state = echo.state;
      process.stdout.write(`moved (ply ${state.ply})\n`);
    }
  }
}

// Stay connected long enough for the other side to react.
await new Promise((r) => setTimeout(r, Number(opt('hold', 12000))));
if (ACTION === 'leave') send({ t: 'room.leave' });
socket.close();
process.stdout.write('done\n');
