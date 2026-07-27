import { strict as assert } from 'node:assert';
import test from 'node:test';

import { Bot, BOT_PROFILES, qualityOf } from '../ai.js';
import { Game } from '../engine.js';
import { MoveKind, Orientation, type BotLevel } from '../types.js';

/** Play a full bot-vs-bot game and return the winner (or null on a stall). */
function playOut(
  a: BotLevel,
  b: BotLevel,
  seed: number,
  maxPly = 260,
): { winner: number | null; plies: number } {
  const g = new Game();
  const bots = [
    new Bot(a, g.size, 2, seed),
    new Bot(b, g.size, 2, seed ^ 0x5bf03635),
  ];
  let plies = 0;
  while (!g.isOver && plies < maxPly) {
    const res = bots[g.turn].choose(g, { timeMs: 120 });
    const applied = g.apply(res.move);
    assert.ok(applied.ok, `bot produced an illegal move: ${JSON.stringify(res.move)}`);
    plies += 1;
  }
  return { winner: g.winner, plies };
}

test('every level always returns a legal move from the opening', () => {
  for (const level of Object.keys(BOT_PROFILES) as BotLevel[]) {
    const g = new Game();
    const bot = new Bot(level, 9, 2, 42);
    const res = bot.choose(g, { timeMs: 200 });
    assert.ok(g.isLegal(res.move).ok, `${level} produced an illegal opening move`);
  }
});

test('bots never produce an illegal move over a long game', () => {
  const g = new Game();
  const bots = [new Bot('hard', 9, 2, 7), new Bot('medium', 9, 2, 11)];
  let plies = 0;
  while (!g.isOver && plies < 200) {
    const res = bots[g.turn].choose(g, { timeMs: 90 });
    assert.ok(g.isLegal(res.move).ok, `illegal at ply ${plies}: ${JSON.stringify(res.move)}`);
    g.apply(res.move);
    plies += 1;
  }
  assert.ok(plies > 8, 'the game should last more than a few moves');
});

test('a bot takes the winning move when one is available', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 6, c: 0 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  for (const level of ['medium', 'hard', 'expert', 'master'] as BotLevel[]) {
    const bot = new Bot(level, 9, 2, 3);
    const res = bot.choose(fresh, { strict: true, timeMs: 400 });
    assert.equal(res.move.kind, MoveKind.Step, `${level} should step, not wall`);
    if (res.move.kind === MoveKind.Step) {
      assert.equal(res.move.to.r, 0, `${level} should walk onto the goal row`);
    }
  }
});

test('a strong bot blocks an opponent who is one step from winning', () => {
  // Red (seat 1) stands on e2 and needs a single step to reach row 8. An
  // earlier wall at c2h already closes the left-hand escape, so the one and
  // only saving move for blue is e2h: it pushes red from 1 step to 3, which
  // is exactly enough for blue — two steps away — to win the race.
  const g = new Game();
  g.players[0].pos = { r: 2, c: 4 };
  g.players[1].pos = { r: 7, c: 4 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  assert.ok(fresh.apply({ kind: MoveKind.Wall, wall: { r: 7, c: 2, o: 0 } }).ok);
  fresh.turn = 0;
  assert.equal(fresh.distanceFor(0), 2);
  assert.equal(fresh.distanceFor(1), 1, 'red is one step from home');

  const bot = new Bot('expert', 9, 2, 5);
  const res = bot.choose(fresh, { strict: true, timeMs: 1500 });
  assert.equal(res.move.kind, MoveKind.Wall, 'stepping loses on the spot');
  const probe = Game.fromState(fresh.toState());
  assert.ok(probe.apply(res.move).ok);
  assert.ok(
    probe.distanceFor(1) >= 3,
    `the wall must cost red at least two tempi, got ${probe.distanceFor(1)}`,
  );
});

test('the bot races instead of walling when the race is already won', () => {
  // Red is out of walls, so it can only run. Blue is two steps from home and
  // red is three: racing mates in three plies, walling first mates in five,
  // and the search must prefer the shorter win.
  const g = new Game();
  g.players[0].pos = { r: 2, c: 4 };
  g.players[1].pos = { r: 5, c: 0 };
  g.players[1].walls = 0;
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  assert.equal(fresh.distanceFor(0), 2);
  assert.equal(fresh.distanceFor(1), 3);
  const bot = new Bot('expert', 9, 2, 17);
  const res = bot.choose(fresh, { strict: true, timeMs: 1500 });
  assert.equal(res.move.kind, MoveKind.Step, 'spending a tempo on a wall throws the win away');
  if (res.move.kind === MoveKind.Step) assert.equal(res.move.to.r, 1);
});

test('a claimed forced win is actually winnable', () => {
  // The same race, but red still holds a full set of walls. A deep search may
  // legitimately prove a forced win here — so rather than guessing whether the
  // position is won, play the bot's own verdict out and check it was telling
  // the truth. This catches an evaluation that reports mates it cannot deliver.
  const g = new Game();
  g.players[0].pos = { r: 2, c: 4 };
  g.players[1].pos = { r: 5, c: 0 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;

  const bot = new Bot('expert', 9, 2, 17);
  const res = bot.choose(fresh, { strict: true, timeMs: 1500 });
  assert.ok(fresh.isLegal(res.move).ok, 'the chosen move must be legal');

  if (Math.abs(res.score) < 90_000) return; // no claim made, nothing to verify

  const claimsWinForSeat0 = res.score > 0;
  const board = Game.fromState(fresh.toState());
  const players = [new Bot('expert', 9, 2, 31), new Bot('expert', 9, 2, 37)];
  assert.ok(board.apply(res.move).ok);
  for (let i = 0; i < 120 && !board.isOver; i++) {
    const reply = players[board.turn].choose(board, { strict: true, timeMs: 220 });
    assert.ok(board.apply(reply.move).ok, 'bots must only produce legal moves');
  }
  assert.notEqual(board.winner, null, 'a claimed forced win must actually finish');
  assert.equal(
    board.winner === 0,
    claimsWinForSeat0,
    `search claimed ${res.score} for seat 0 but seat ${board.winner} won`,
  );
});

test('a bot never walls itself into a longer route for nothing', () => {
  const g = new Game();
  const bot = new Bot('expert', 9, 2, 9);
  const res = bot.choose(g, { strict: true, timeMs: 500 });
  if (res.move.kind === MoveKind.Wall) {
    const probe = g.clone();
    const mine = probe.distanceFor(0);
    probe.apply(res.move);
    assert.ok(probe.distanceFor(0) <= mine + 2, 'self-inflicted detours must stay small');
  }
});

test('search reports sane statistics', () => {
  const g = new Game();
  const bot = new Bot('hard', 9, 2, 13);
  const res = bot.choose(g, { strict: true, timeMs: 700 });
  assert.ok(res.nodes > 100, `expected a real search, got ${res.nodes} nodes`);
  assert.ok(res.depth >= 2, `expected depth >= 2, got ${res.depth}`);
  assert.ok(res.pv.length >= 1);
  assert.ok(res.ms < 4000, 'search must respect its time budget');
});

test('stronger levels beat weaker ones over a small match', () => {
  // Four games with alternating colours; the stronger side should not lose the match.
  let strongWins = 0;
  let weakWins = 0;
  for (let i = 0; i < 4; i++) {
    const strongFirst = i % 2 === 0;
    const r = strongFirst
      ? playOut('hard', 'novice', 1000 + i)
      : playOut('novice', 'hard', 1000 + i);
    if (r.winner === null) continue;
    const strongSeat = strongFirst ? 0 : 1;
    if (r.winner === strongSeat) strongWins += 1;
    else weakWins += 1;
  }
  assert.ok(
    strongWins > weakWins,
    `hard should dominate novice, got ${strongWins}-${weakWins}`,
  );
});

test('games between bots actually finish', () => {
  const r = playOut('medium', 'medium', 4242);
  assert.notEqual(r.winner, null, 'a medium-vs-medium game should reach a result');
  assert.ok(r.plies < 240, `game took ${r.plies} plies`);
});

test('bots respect their time budget', () => {
  const g = new Game();
  const bot = new Bot('master', 9, 2, 21);
  const started = Date.now();
  bot.choose(g, { strict: true, timeMs: 300 });
  const spent = Date.now() - started;
  assert.ok(spent < 2200, `master overran its budget: ${spent}ms`);
});

test('the bot copes with a heavily walled board', () => {
  const g = new Game();
  const walls = [
    { r: 6, c: 1, o: 0 },
    { r: 6, c: 3, o: 0 },
    { r: 2, c: 1, o: 0 },
    { r: 2, c: 5, o: 0 },
    { r: 4, c: 2, o: 1 },
    { r: 4, c: 6, o: 1 },
  ] as const;
  for (const w of walls) {
    g.turn = 0;
    if (g.isWallLegal(w, 0).ok) {
      g.apply({ kind: MoveKind.Wall, wall: { ...w } });
      g.players[0].walls += 1;
    }
  }
  g.turn = 0;
  const bot = new Bot('expert', 9, 2, 33);
  const res = bot.choose(g, { strict: true, timeMs: 600 });
  assert.ok(g.isLegal(res.move).ok);
});

test('the bot handles 4-player positions', () => {
  const g = new Game({ players: 4 });
  const bot = new Bot('hard', 9, 4, 77);
  for (let i = 0; i < 8; i++) {
    const res = bot.choose(g, { timeMs: 150 });
    assert.ok(g.isLegal(res.move).ok, `illegal 4P move at ply ${i}`);
    g.apply(res.move);
  }
});

test('a bot with no walls left still plays', () => {
  const g = new Game({ wallsPerPlayer: 0 });
  const bot = new Bot('expert', 9, 2, 55);
  const res = bot.choose(g, { strict: true, timeMs: 300 });
  assert.equal(res.move.kind, MoveKind.Step);
  assert.ok(g.isLegal(res.move).ok);
});

test('the same seed produces the same move', () => {
  const g = new Game();
  const a = new Bot('medium', 9, 2, 4242).choose(g, { timeMs: 200 });
  const b = new Bot('medium', 9, 2, 4242).choose(g, { timeMs: 200 });
  assert.deepEqual(a.move, b.move);
});

test('analysis rates the best move as best and a bad one as a blunder', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 6, c: 0 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  const bot = new Bot('hard', 9, 2, 12);

  // Stepping onto the goal row wins on the spot.
  const winning = bot.analyse(fresh, { kind: MoveKind.Step, to: { r: 0, c: 4 } }, 300);
  assert.equal(winning.loss, 0, 'the winning move cannot lose anything');
  assert.equal(qualityOf(winning.loss), 'best');

  // Walking away from a win instead is, by definition, the worst available.
  const retreat = bot.analyse(fresh, { kind: MoveKind.Step, to: { r: 2, c: 4 } }, 300);
  assert.ok(retreat.loss > 0, 'walking away from a forced win must cost something');
  assert.equal(qualityOf(retreat.loss), 'blunder');
});

test('a reported loss is bounded so one lost game cannot swamp an average', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 7, c: 4 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  const bot = new Bot('hard', 9, 2, 3);
  const away = bot.analyse(fresh, { kind: MoveKind.Step, to: { r: 2, c: 4 } }, 300);
  assert.ok(
    away.loss <= 1_100,
    `mate-score differences must be clamped, got ${away.loss}`,
  );
});

test('quality thresholds are ordered', () => {
  assert.equal(qualityOf(0), 'best');
  assert.equal(qualityOf(15), 'best');
  assert.equal(qualityOf(50), 'good');
  assert.equal(qualityOf(100), 'inaccuracy');
  assert.equal(qualityOf(300), 'mistake');
  assert.equal(qualityOf(900), 'blunder');
});

test('walls remain legal after the bot considers them', () => {
  // Regression guard: the ordering pass makes and unmakes wall moves, so the
  // board must be pristine afterwards.
  const g = new Game();
  const key = g.positionKey();
  const bot = new Bot('expert', 9, 2, 8);
  bot.choose(g, { strict: true, timeMs: 400 });
  assert.equal(g.positionKey(), key, 'choose() must not mutate the caller board');
});
