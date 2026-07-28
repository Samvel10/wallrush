#!/usr/bin/env node
/**
 * Bot-vs-bot round robin, for checking that the levels are actually ranked.
 *
 * Advertised difficulty is a promise. If "expert" only beats "hard" half the
 * time, the ladder is decoration and the rating we award for beating a bot is
 * wrong. This plays every pair both ways, with a different seed per game so
 * the bots do not replay one deterministic line, and prints the win matrix
 * plus the Elo the results imply.
 *
 *   node scripts/tournament.mjs                       # default ladder
 *   node scripts/tournament.mjs --games 8 --levels hard,expert,master
 */

import { BOT_PROFILES, Bot, Game } from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const LEVELS = opt('levels', 'novice,easy,medium,hard,expert,master').split(',');
const GAMES = Number(opt('games', 4)); // per ordered pair
const MAX_PLY = Number(opt('maxPly', 220));
/**
 * Thinking time is scaled, never capped.
 *
 * A cap makes every level above it identical — which is exactly the thing the
 * tournament is meant to measure. Scaling keeps the *ratio* between levels,
 * so a run at --scale 0.25 still answers "is master stronger than expert?"
 * in a quarter of the wall clock.
 */
const SCALE = Number(opt('scale', 1));

const profileFor = (level) =>
  SCALE === 1
    ? level
    : { ...BOT_PROFILES[level], timeMs: Math.max(20, Math.round(BOT_PROFILES[level].timeMs * SCALE)) };

/** One game. Returns 1 if `a` (seat 0) won, 0 if `b` won, 0.5 for a stalemate. */
function play(a, b, seed) {
  const game = new Game();
  const bots = [
    new Bot(profileFor(a), 9, 2, seed),
    new Bot(profileFor(b), 9, 2, (seed * 2654435761) >>> 0),
  ];
  while (game.winner === null && game.ply < MAX_PLY) {
    const { move } = bots[game.turn].choose(game);
    if (!move) return 0.5;
    game.apply(move);
  }
  if (game.winner === null) return 0.5; // ran out of patience, not a real result
  return game.winner === 0 ? 1 : 0;
}

const score = new Map(LEVELS.map((l) => [l, 0]));
const played = new Map(LEVELS.map((l) => [l, 0]));
const matrix = new Map();

const t0 = Date.now();
let n = 0;
for (const a of LEVELS) {
  for (const b of LEVELS) {
    if (a === b) continue;
    let wins = 0;
    for (let g = 0; g < GAMES; g++) {
      const r = play(a, b, 0x9e3779b9 + n * 7919 + g * 104729);
      wins += r;
      score.set(a, score.get(a) + r);
      score.set(b, score.get(b) + (1 - r));
      played.set(a, played.get(a) + 1);
      played.set(b, played.get(b) + 1);
      n++;
    }
    matrix.set(`${a}>${b}`, wins / GAMES);
    process.stderr.write(`${a} vs ${b}: ${((wins / GAMES) * 100).toFixed(0)}%\n`);
  }
}

// Iterative Elo fit: adjust each rating towards the score its games imply.
const elo = new Map(LEVELS.map((l) => [l, 1500]));
const expected = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));
for (let iter = 0; iter < 4000; iter++) {
  for (const a of LEVELS) {
    let exp = 0;
    let act = 0;
    for (const b of LEVELS) {
      if (a === b) continue;
      const asWhite = matrix.get(`${a}>${b}`);
      const asBlack = 1 - matrix.get(`${b}>${a}`);
      act += (asWhite + asBlack) * GAMES;
      exp += 2 * GAMES * expected(elo.get(a), elo.get(b));
    }
    elo.set(a, elo.get(a) + 0.6 * (act - exp));
  }
  // Anchor the ladder so the numbers stay comparable between runs.
  const mean = LEVELS.reduce((s, l) => s + elo.get(l), 0) / LEVELS.length;
  for (const l of LEVELS) elo.set(l, elo.get(l) - mean + 1300);
}

const pad = (s, w) => String(s).padEnd(w);
process.stdout.write(`\n${pad('', 9)}${LEVELS.map((l) => pad(l.slice(0, 6), 8)).join('')}\n`);
for (const a of LEVELS) {
  const row = LEVELS.map((b) =>
    pad(a === b ? '—' : `${(matrix.get(`${a}>${b}`) * 100).toFixed(0)}%`, 8),
  ).join('');
  process.stdout.write(`${pad(a.slice(0, 8), 9)}${row}\n`);
}

process.stdout.write('\nrank  level    score    fitted Elo\n');
const ranked = [...LEVELS].sort((x, y) => score.get(y) - score.get(x));
ranked.forEach((l, i) => {
  const pct = ((score.get(l) / played.get(l)) * 100).toFixed(0);
  process.stdout.write(
    `${pad(i + 1, 6)}${pad(l, 9)}${pad(`${pct}%`, 9)}${Math.round(elo.get(l))}\n`,
  );
});
process.stdout.write(`\n${n} games in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// A ladder where a stronger level loses its head-to-head is a real defect:
// `ranked` is by result, `LEVELS` is by advertised strength, so an adjacent
// pair whose advertised order disagrees with the result is an inversion.
let broken = 0;
for (let i = 0; i < ranked.length - 1; i++) {
  const [a, b] = [ranked[i], ranked[i + 1]];
  if (LEVELS.indexOf(a) < LEVELS.indexOf(b)) {
    process.stdout.write(`⚠ ${b} is advertised stronger than ${a} but finished below it\n`);
    broken++;
  }
}
process.stdout.write(broken === 0 ? '✓ ladder is monotonic\n' : `⚠ ${broken} inversion(s)\n`);
