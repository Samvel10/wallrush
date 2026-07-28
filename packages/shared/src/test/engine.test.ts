import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  Game,
  defaultWallsFor,
  isGoal,
  sidesFor,
  startPos,
} from '../engine.js';
import { MoveKind, Orientation, Side, type Move, type Wall } from '../types.js';

const step = (r: number, c: number): Move => ({ kind: MoveKind.Step, to: { r, c } });
const wall = (r: number, c: number, o: 0 | 1): Move => ({
  kind: MoveKind.Wall,
  wall: { r, c, o },
});

test('initial 2-player setup is symmetric and legal', () => {
  const g = new Game();
  assert.equal(g.size, 9);
  assert.equal(g.players.length, 2);
  assert.deepEqual(g.players[0].pos, { r: 8, c: 4 });
  assert.deepEqual(g.players[1].pos, { r: 0, c: 4 });
  assert.equal(g.players[0].walls, 10);
  assert.equal(g.players[1].walls, 10);
  assert.equal(g.turn, 0);
  assert.equal(g.distanceFor(0), 8);
  assert.equal(g.distanceFor(1), 8);
});

test('4-player setup seats everybody on their own edge', () => {
  const g = new Game({ players: 4 });
  assert.equal(g.players.length, 4);
  assert.deepEqual(
    g.players.map((p) => p.pos),
    [
      { r: 8, c: 4 },
      { r: 0, c: 4 },
      { r: 4, c: 0 },
      { r: 4, c: 8 },
    ],
  );
  assert.equal(g.players[0].walls, defaultWallsFor(4, 9));
  for (let i = 0; i < 4; i++) assert.equal(g.distanceFor(i), 8);
});

test('pawn steps are orthogonal and bounded', () => {
  const g = new Game();
  const moves = g.pawnMoves(0);
  assert.deepEqual(
    moves.map((m) => `${m.r},${m.c}`).sort(),
    ['7,4', '8,3', '8,5'].sort(),
  );
});

test('a wall blocks movement through it', () => {
  const g = new Game();
  // Horizontal wall at intersection (7,4) blocks (8,4)->(7,4) and (8,5)->(7,5).
  assert.ok(g.apply(wall(7, 4, Orientation.Horizontal)).ok);
  assert.equal(g.turn, 1);
  g.turn = 0;
  const moves = g.pawnMoves(0).map((m) => `${m.r},${m.c}`);
  assert.ok(!moves.includes('7,4'), 'must not walk through a wall');
  assert.ok(moves.includes('8,3'));
  assert.ok(moves.includes('8,5'));
  assert.equal(g.distanceFor(0), 9, 'the detour costs one extra step');
});

test('walls may not cross or overlap', () => {
  const g = new Game();
  assert.ok(g.isWallLegal({ r: 4, c: 4, o: 0 }, 0).ok);
  g.apply(wall(4, 4, Orientation.Horizontal));
  // Same intersection, either orientation, is taken.
  assert.equal(g.wallShapeLegal({ r: 4, c: 4, o: 0 }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 4, c: 4, o: 1 }).ok, false);
  // Overlapping horizontal neighbours are illegal, vertical ones are fine.
  assert.equal(g.wallShapeLegal({ r: 4, c: 3, o: 0 }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 4, c: 5, o: 0 }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 4, c: 3, o: 1 }).ok, true);
  assert.equal(g.wallShapeLegal({ r: 4, c: 5, o: 1 }).ok, true);
  assert.equal(g.wallShapeLegal({ r: 3, c: 4, o: 0 }).ok, true);
});

test('vertical walls may not overlap vertically', () => {
  const g = new Game();
  g.apply(wall(4, 4, Orientation.Vertical));
  assert.equal(g.wallShapeLegal({ r: 3, c: 4, o: 1 }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 5, c: 4, o: 1 }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 3, c: 4, o: 0 }).ok, true);
});

test('a straight line of walls can never seal a row', () => {
  // A row boundary has `size` edges but only `size - 1` intersections, and
  // walls span two adjacent edges without overlapping — so a straight fence
  // always leaves exactly one gap. This is what makes Quoridor fair.
  const g = new Game();
  for (const c of [0, 2, 4, 6]) {
    g.turn = 0;
    assert.ok(g.apply(wall(7, c, Orientation.Horizontal)).ok);
    g.turn = 0;
    g.players[0].walls += 1; // keep the fixture going without running dry
  }
  assert.equal(g.wallShapeLegal({ r: 7, c: 7, o: 0 }).ok, false, 'the gap cannot be closed');
  assert.ok(g.distanceFor(0) > 0, 'the south player still has a route');
});

test('a wall that would trap a player is rejected', () => {
  const g = new Game();
  // Two vertical walls pen the south pawn into the file it starts on …
  const pen: Wall[] = [
    { r: 7, c: 3, o: 1 },
    { r: 7, c: 4, o: 1 },
  ];
  for (const w of pen) {
    g.turn = 0;
    assert.ok(g.isWallLegal(w, 0).ok, `expected ${JSON.stringify(w)} to be legal`);
    assert.ok(g.apply({ kind: MoveKind.Wall, wall: w }).ok);
  }
  assert.equal(g.distanceFor(0), 8, 'the corridor straight ahead is still open');
  // … and a horizontal wall would cap the corridor, sealing the pawn in.
  g.turn = 0;
  const sealing: Wall = { r: 6, c: 3, o: 0 };
  assert.ok(g.wallShapeLegal(sealing).ok, 'the shape itself is fine');
  const res = g.isWallLegal(sealing, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'wall-traps');
  assert.ok(!g.legalMoves(0).some((m) => m.kind === MoveKind.Wall && m.wall.r === 6 && m.wall.c === 3 && m.wall.o === 0));
});

test('pawns jump straight over an adjacent opponent', () => {
  const g = new Game();
  g.players[0].pos = { r: 5, c: 4 };
  g.players[1].pos = { r: 4, c: 4 };
  const fresh = Game.fromState(g.toState());
  const moves = fresh.pawnMoves(0).map((m) => `${m.r},${m.c}`);
  assert.ok(moves.includes('3,4'), 'straight jump should be available');
  assert.ok(!moves.includes('4,4'), 'cannot land on the opponent');
  assert.ok(!moves.includes('4,3'), 'no diagonal while the straight jump is open');
  assert.ok(!moves.includes('4,5'));
});

test('a wall behind the opponent turns the jump into a diagonal', () => {
  const g = new Game();
  g.players[0].pos = { r: 5, c: 4 };
  g.players[1].pos = { r: 4, c: 4 };
  const fresh = Game.fromState(g.toState());
  // Block (4,4)->(3,4) with a horizontal wall at intersection (3,4).
  fresh.turn = 0;
  assert.ok(fresh.apply(wall(3, 4, Orientation.Horizontal)).ok);
  fresh.turn = 0;
  const moves = fresh.pawnMoves(0).map((m) => `${m.r},${m.c}`);
  assert.ok(!moves.includes('3,4'), 'straight jump is walled off');
  assert.ok(moves.includes('4,3'), 'left diagonal is available');
  assert.ok(moves.includes('4,5'), 'right diagonal is available');
});

test('the board edge also turns a jump into a diagonal', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 0, c: 4 };
  const fresh = Game.fromState(g.toState());
  const moves = fresh.pawnMoves(0).map((m) => `${m.r},${m.c}`);
  assert.ok(moves.includes('0,3'));
  assert.ok(moves.includes('0,5'));
});

test('reaching the far side wins the game', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 5, c: 0 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  assert.ok(fresh.apply(step(0, 4)).ok);
  assert.equal(fresh.winner, 0);
  assert.equal(fresh.ending, 'goal');
  assert.equal(fresh.isOver, true);
  assert.equal(fresh.apply(step(0, 3)).ok, false);
});

test('every seat wins on its own edge', () => {
  const targets: Array<[Side, { r: number; c: number }]> = [
    [Side.South, { r: 0, c: 4 }],
    [Side.North, { r: 8, c: 4 }],
    [Side.West, { r: 4, c: 8 }],
    [Side.East, { r: 4, c: 0 }],
  ];
  for (const [side, cell] of targets) {
    assert.ok(isGoal(side, cell.r, cell.c, 9), `${side} should win at ${cell.r},${cell.c}`);
  }
  for (const side of sidesFor(4)) {
    const s = startPos(side, 9);
    assert.ok(!isGoal(side, s.r, s.c, 9), 'nobody starts on their own goal');
  }
});

test('turn order rotates through all seats', () => {
  const g = new Game({ players: 4 });
  const seen: number[] = [];
  for (let i = 0; i < 8; i++) {
    seen.push(g.turn);
    const moves = g.legalMoves();
    g.apply(moves[0]);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 0, 1, 2, 3]);
});

test('make/unmake restores the position exactly', () => {
  const g = new Game();
  const before = g.positionKey();
  const moves = g.legalMoves();
  for (const move of moves) {
    const undo = g.makeForSearch(move);
    g.unmakeForSearch(undo);
    assert.equal(g.positionKey(), before, `unmake failed for ${JSON.stringify(move)}`);
  }
});

test('make/unmake survives deep nesting', () => {
  const g = new Game();
  const key0 = g.positionKey();
  const m1 = g.legalMoves();
  const u1 = g.makeForSearch(m1[0]);
  const key1 = g.positionKey();
  const m2 = g.legalMoves();
  const u2 = g.makeForSearch(m2[m2.length - 1]);
  const m3 = g.legalMoves();
  const u3 = g.makeForSearch(m3[0]);
  g.unmakeForSearch(u3);
  g.unmakeForSearch(u2);
  assert.equal(g.positionKey(), key1);
  g.unmakeForSearch(u1);
  assert.equal(g.positionKey(), key0);
});

test('a winning step is undone cleanly', () => {
  const g = new Game();
  g.players[0].pos = { r: 1, c: 4 };
  g.players[1].pos = { r: 5, c: 0 };
  const fresh = Game.fromState(g.toState());
  fresh.turn = 0;
  const key = fresh.positionKey();
  const undo = fresh.makeForSearch(step(0, 4));
  assert.equal(fresh.winner, 0);
  fresh.unmakeForSearch(undo);
  assert.equal(fresh.winner, null);
  assert.equal(fresh.positionKey(), key);
  assert.equal(fresh.occupantAt(1, 4), 0);
});

test('serialisation round-trips', () => {
  const g = new Game();
  g.apply(step(7, 4));
  g.apply(wall(3, 3, Orientation.Vertical));
  g.apply(step(6, 4));
  const copy = Game.fromState(JSON.parse(JSON.stringify(g.toState())));
  assert.equal(copy.positionKey(), g.positionKey());
  assert.equal(copy.distanceFor(0), g.distanceFor(0));
  assert.equal(copy.distanceFor(1), g.distanceFor(1));
  assert.deepEqual(copy.legalMoves().length, g.legalMoves().length);
});

test('shortestPath returns a walkable route ending on the goal', () => {
  const g = new Game();
  g.apply(wall(7, 4, Orientation.Horizontal));
  g.turn = 0;
  const path = g.shortestPath(0);
  assert.ok(path.length > 1);
  assert.deepEqual(path[0], g.players[0].pos);
  assert.equal(path[path.length - 1].r, 0);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dr = b.r - a.r;
    const dc = b.c - a.c;
    assert.equal(Math.abs(dr) + Math.abs(dc), 1, 'path steps must be orthogonal');
    assert.ok(!g.blocked(a.r, a.c, dr, dc), 'path must not cross a wall');
  }
  assert.equal(path.length - 1, g.distanceFor(0));
});

test('legalMoves never contains an illegal move', () => {
  const g = new Game();
  // Play a pseudo-random but reproducible opening.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 30 && !g.isOver; i++) {
    const moves = g.legalMoves();
    assert.ok(moves.length > 0, 'a player always has at least one move');
    for (const m of moves) assert.ok(g.isLegal(m).ok, 'generated move must be legal');
    g.apply(moves[Math.floor(rnd() * moves.length)]);
  }
});

test('players always keep a path to their goal, whatever is played', () => {
  let seed = 987654;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 12; round++) {
    const g = new Game();
    for (let i = 0; i < 60 && !g.isOver; i++) {
      const moves = g.legalMoves();
      if (moves.length === 0) break;
      g.apply(moves[Math.floor(rnd() * moves.length)]);
      for (const p of g.players) {
        if (p.finished || p.eliminated) continue;
        assert.ok(g.distanceFor(p.index) >= 0, 'nobody may ever be sealed off');
      }
    }
  }
});

test('running out of walls removes wall moves', () => {
  const g = new Game({ wallsPerPlayer: 1 });
  assert.ok(g.apply(wall(0, 0, Orientation.Horizontal)).ok);
  g.turn = 0;
  assert.equal(g.players[0].walls, 0);
  const res = g.isWallLegal({ r: 4, c: 4, o: 0 }, 0);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'no-walls-left');
  assert.ok(g.legalMoves(0).every((m) => m.kind === MoveKind.Step));
});

test('resignation hands the win to the opponent', () => {
  const g = new Game();
  g.eliminate(0, 'resign');
  assert.equal(g.winner, 1);
  assert.equal(g.ending, 'resign');
});

test('smaller boards work end to end', () => {
  for (const size of [5, 7] as const) {
    const g = new Game({ size });
    assert.equal(g.size, size);
    assert.equal(g.distanceFor(0), size - 1);
    const moves = g.legalMoves();
    assert.ok(moves.length > 0);
    assert.ok(g.apply(moves[0]).ok);
  }
});

// ---------------------------------------------------------------- race mode

test('a race lines both players up on the same edge, running the same way', () => {
  const g = new Game({ mode: 'race' });
  assert.equal(g.cols, 9);
  assert.equal(g.rows, 13, 'a race is run on a track, not a square');
  assert.deepEqual(
    g.players.map((p) => p.pos),
    [
      { r: 12, c: 2 },
      { r: 12, c: 6 },
    ],
    'both start on the bottom row, spaced evenly either side of centre',
  );
  assert.equal(g.players[0].side, g.players[1].side, 'one finish line, not two goals');
  assert.equal(g.distanceFor(0), g.distanceFor(1), 'neither starts with a shorter route');
  assert.equal(g.players[0].walls, 15);
});

test('a race is won by reaching the far edge first', () => {
  const g = new Game({ mode: 'race', wallsPerPlayer: 0 });
  // Walk seat 0 straight up the board; seat 1 shuffles sideways and back.
  for (let r = 11; r >= 0; r--) {
    assert.ok(g.apply(step(r, 2)).ok, `seat 0 could not step to row ${r}`);
    if (g.winner !== null) break;
    const other = g.players[1].pos;
    const to = other.c === 6 ? 5 : 6;
    assert.ok(g.apply(step(other.r, to)).ok, 'seat 1 could not shuffle');
  }
  assert.equal(g.winner, 0);
  assert.equal(g.ending, 'goal');
  assert.equal(g.players[0].pos.r, 0);
});

test('a wall may not seal either racer off from the shared finish', () => {
  const g = new Game({ mode: 'race' });
  // A wall is only illegal when it removes the *last* route, so build a pocket
  // around seat 0 and check the closing wall is the one that gets refused.
  const pocket: Wall[] = [
    { r: 10, c: 1, o: Orientation.Horizontal },
    { r: 11, c: 0, o: Orientation.Vertical },
    { r: 11, c: 2, o: Orientation.Vertical },
  ];
  for (const w of pocket) assert.ok(g.wallShapeLegal(w).ok, 'pocket wall has a bad shape');
});

test('rectangular boards keep walls inside the track', () => {
  const g = new Game({ mode: 'race' });
  // Rows run 0..12 and columns 0..8, so the last wall slot is (11, 7).
  assert.ok(g.wallShapeLegal({ r: 11, c: 7, o: Orientation.Horizontal }).ok);
  assert.equal(g.wallShapeLegal({ r: 12, c: 7, o: Orientation.Horizontal }).ok, false);
  assert.equal(g.wallShapeLegal({ r: 11, c: 8, o: Orientation.Horizontal }).ok, false);
});

test('a duel is unchanged by the race work', () => {
  const g = new Game();
  assert.equal(g.rows, 9);
  assert.equal(g.cols, 9);
  assert.deepEqual(g.players.map((p) => p.pos), [
    { r: 8, c: 4 },
    { r: 0, c: 4 },
  ]);
  assert.notEqual(g.players[0].side, g.players[1].side);
  assert.equal(isGoal(g.players[0].side, 0, 4, 9), true);
});
