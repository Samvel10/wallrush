import { strict as assert } from 'node:assert';
import test from 'node:test';

import { Game } from '../engine.js';
import {
  moveName,
  parseMove,
  parseTranscript,
  squareName,
  transcript,
  wallName,
} from '../notation.js';
import { applyElo, expectedScore, tierOf, START_RATING } from '../rating.js';
import { MoveKind, Orientation, type Move } from '../types.js';

test('squares read like a chessboard', () => {
  assert.equal(squareName({ r: 8, c: 4 }, 9), 'e1');
  assert.equal(squareName({ r: 0, c: 4 }, 9), 'e9');
  assert.equal(squareName({ r: 0, c: 0 }, 9), 'a9');
  assert.equal(squareName({ r: 8, c: 8 }, 9), 'i1');
});

test('walls carry an orientation suffix', () => {
  assert.equal(wallName({ r: 7, c: 4, o: 0 }, 9), 'e1h');
  assert.equal(wallName({ r: 0, c: 0, o: 1 }, 9), 'a8v');
});

test('notation round-trips for every legal move on a fresh board', () => {
  const g = new Game();
  for (const move of g.legalMoves()) {
    const text = moveName(move, 9);
    const back = parseMove(text, 9);
    assert.ok(back, `failed to parse ${text}`);
    assert.equal(moveName(back!, 9), text);
    assert.equal(back!.kind, move.kind);
  }
});

test('bad notation is rejected rather than guessed', () => {
  for (const bad of ['', 'z9', 'e0', 'e10', 'e1x', '9e', 'hello']) {
    assert.equal(parseMove(bad, 9), null, `"${bad}" should not parse`);
  }
});

test('transcripts round-trip', () => {
  const moves: Move[] = [
    { kind: MoveKind.Step, to: { r: 7, c: 4 } },
    { kind: MoveKind.Wall, wall: { r: 3, c: 3, o: Orientation.Vertical } },
    { kind: MoveKind.Step, to: { r: 1, c: 4 } },
  ];
  const text = transcript(moves, 9);
  assert.equal(text, 'e2 d5v e8');
  const back = parseTranscript(text, 9);
  assert.equal(back.length, 3);
  assert.equal(transcript(back, 9), text);
});

test('a replayed transcript reproduces the position', () => {
  const g = new Game();
  let seed = 24680;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const played: Move[] = [];
  for (let i = 0; i < 24 && !g.isOver; i++) {
    const moves = g.legalMoves();
    const move = moves[Math.floor(rnd() * moves.length)];
    g.apply(move);
    played.push(move);
  }
  const replay = new Game();
  for (const move of parseTranscript(transcript(played, 9), 9)) {
    assert.ok(replay.apply(move).ok, `replay rejected ${moveName(move, 9)}`);
  }
  assert.equal(replay.positionKey(), g.positionKey());
});

test('elo moves in the right direction', () => {
  const win = applyElo(START_RATING, 30, START_RATING, 1);
  const loss = applyElo(START_RATING, 30, START_RATING, 0);
  const draw = applyElo(START_RATING, 30, START_RATING, 0.5);
  assert.ok(win.delta > 0);
  assert.ok(loss.delta < 0);
  assert.equal(draw.delta, 0);
  assert.equal(win.delta, -loss.delta);
});

test('provisional accounts move faster than settled ones', () => {
  const fresh = applyElo(START_RATING, 2, START_RATING, 1);
  const settled = applyElo(START_RATING, 200, START_RATING, 1);
  assert.ok(fresh.delta > settled.delta);
});

test('beating a much stronger opponent is worth more', () => {
  const upset = applyElo(1200, 50, 1900, 1);
  const expected = applyElo(1900, 50, 1200, 1);
  assert.ok(upset.delta > expected.delta);
  assert.ok(expectedScore(1900, 1200) > 0.9);
});

test('ratings never fall below the floor', () => {
  let r = 150;
  for (let i = 0; i < 40; i++) r = applyElo(r, 100, 2400, 0).after;
  assert.ok(r >= 100);
});

test('tiers are ordered', () => {
  assert.equal(tierOf(1200), 'bronze');
  assert.equal(tierOf(1500), 'silver');
  assert.equal(tierOf(1700), 'gold');
  assert.equal(tierOf(1900), 'platinum');
  assert.equal(tierOf(2100), 'diamond');
  assert.equal(tierOf(2300), 'master');
  assert.equal(tierOf(2500), 'grandmaster');
});
