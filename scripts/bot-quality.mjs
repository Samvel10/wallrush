#!/usr/bin/env node
/**
 * How often does a bot play a move that achieves nothing?
 *
 * "Stupid" is not the same as "weak". A weak player picks the second-best
 * plan; a stupid one steps away from the goal, or spends a wall that costs the
 * opponent nothing. This plays the level under test against a strong,
 * wall-happy opponent — the situation a human creates when they build a trap —
 * and counts the moves that made the bot's own position no better.
 *
 *   node scripts/bot-quality.mjs --levels easy,medium,hard --games 6
 *   node scripts/bot-quality.mjs --mode race
 */

import { BOT_PROFILES, Bot, Game, MoveKind } from '../packages/shared/dist/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const LEVELS = opt('levels', 'novice,easy,medium,hard').split(',');
const GAMES = Number(opt('games', 6));
const MAX_PLY = Number(opt('maxPly', 160));
/** The race board is a different shape; the bots have never been measured on it. */
const MODE = opt('mode', 'duel');

function judge(game, seat, move) {
  const me = game.players[seat];
  const before = game.distanceToGoal(me.pos.r, me.pos.c, me.side);
  if (move.kind === MoveKind.Step) {
    const after = game.distanceToGoal(move.to.r, move.to.c, me.side);
    // Could any step have done better than the one played?
    let best = Infinity;
    for (const to of game.pawnMoves(seat)) {
      const d = game.distanceToGoal(to.r, to.c, me.side);
      if (d >= 0 && d < best) best = d;
    }
    if (after > before && best < before) return 'backward';
    if (after >= before && best < before) return 'idle';
    return 'ok';
  }
  // A wall counts as wasted only when it changes *nothing on the board* — not
  // the opponent's route and not our own.
  //
  // The stricter version ("it must lengthen the opponent") is wrong, and
  // measurably so: in a race both players run the same way, so a good wall
  // frequently costs the placer a step too, and a wall can be strong today
  // while changing no shortest path until the pawns arrive. Judging those as
  // mistakes made the race board look far worse than it plays.
  const distances = (g) =>
    g.players
      .filter((p) => !p.eliminated)
      .map((p) => Math.max(0, g.distanceToGoal(p.pos.r, p.pos.c, p.side)))
      .join(',');
  const probe = Game.fromState(game.toState());
  const was = distances(probe);
  if (!probe.apply(move).ok) return 'ok';
  return distances(probe) === was ? 'wasted-wall' : 'ok';
}

const rows = [];
for (const level of LEVELS) {
  const tally = { ok: 0, backward: 0, idle: 0, 'wasted-wall': 0 };
  for (let g = 0; g < GAMES; g++) {
    const game = new Game({ mode: MODE });
    // The opponent is deliberately strong and fond of walls: this is what a
    // person does when they set out to trap the bot.
    const rival = new Bot(
      { ...BOT_PROFILES.expert, wallShyness: 0 },
      game.cols,
      2,
      0x2545f491 + g * 7919,
      game.rows,
    );
    const bot = new Bot(level, game.cols, 2, 0x9e3779b9 + g * 104729, game.rows);
    while (game.winner === null && game.ply < MAX_PLY) {
      const seat = game.turn;
      const { move } = seat === 0 ? rival.choose(game, { strict: true }) : bot.choose(game);
      if (!move) break;
      if (seat === 1) tally[judge(game, seat, move)] += 1;
      game.apply(move);
    }
  }
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  const bad = total - tally.ok;
  rows.push({ level, total, ...tally, pct: ((bad / total) * 100).toFixed(1) });
}

const pad = (s, w) => String(s).padEnd(w);
process.stdout.write(
  `${pad('level', 9)}${pad('moves', 7)}${pad('backward', 10)}${pad('idle', 7)}${pad('wasted wall', 13)}pointless\n`,
);
for (const r of rows) {
  process.stdout.write(
    `${pad(r.level, 9)}${pad(r.total, 7)}${pad(r.backward, 10)}${pad(r.idle, 7)}${pad(r['wasted-wall'], 13)}${r.pct}%\n`,
  );
}
