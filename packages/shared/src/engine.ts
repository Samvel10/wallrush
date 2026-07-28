/**
 * WallRush — game engine.
 *
 * A compact, allocation-light Quoridor implementation shared by the browser and
 * the server. The same class powers rule enforcement, replays and the bot search,
 * so there is exactly one source of truth for the rules.
 *
 * Internal representation
 * -----------------------
 *   hBlock[r * cols + c]  edge between (r,c) and (r+1,c) is blocked
 *   vBlock[r * cols + c]  edge between (r,c) and (r,c+1) is blocked
 *   wallAt[r * (cols-1) + c]  0 = free, 1 = horizontal wall, 2 = vertical wall
 *
 * Boards are not necessarily square: a race is run on a long track, so every
 * index below carries `cols` for the stride and checks `rows` separately.
 *
 * A horizontal wall anchored at intersection (r,c) blocks hBlock(r,c) and
 * hBlock(r,c+1); a vertical wall blocks vBlock(r,c) and vBlock(r+1,c). Because
 * overlapping walls are illegal, every blocked edge belongs to exactly one wall,
 * which makes make/unmake a simple flag toggle.
 */

import {
  DEFAULT_CONFIG,
  MoveKind,
  Orientation,
  Side,
  type BoardSize,
  type GameConfig,
  type GameMode,
  type GameState,
  type Move,
  type PlayerIndex,
  type PlayerState,
  type Pos,
  type Wall,
} from './types.js';

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], // up
  [1, 0], // down
  [0, -1], // left
  [0, 1], // right
];

/** Perpendicular directions for each entry of DIRS (used for diagonal jumps). */
const PERP: ReadonlyArray<readonly [number, number]>[] = [
  [
    [0, -1],
    [0, 1],
  ],
  [
    [0, -1],
    [0, 1],
  ],
  [
    [-1, 0],
    [1, 0],
  ],
  [
    [-1, 0],
    [1, 0],
  ],
];

export function defaultWallsFor(players: 2 | 4, size: BoardSize, mode: GameMode = 'duel'): number {
  // A race is longer and both players are running the same way, so blocking
  // matters more and there are more walls to do it with.
  if (mode === 'race') return 15;
  if (players === 4) return 5;
  return size >= 9 ? 10 : size === 7 ? 7 : 4;
}

/** Board height for a config: a race runs on a track, a duel on a square. */
export function rowsFor(config: Pick<GameConfig, 'size' | 'rows' | 'mode'>): number {
  if (config.rows) return config.rows;
  return config.mode === 'race' ? RACE_ROWS : config.size;
}

/** Height of the standard race track, measured off the original game. */
export const RACE_ROWS = 13;

/** Seat order used when seating 2 or 4 players. */
export function sidesFor(players: 2 | 4, mode: GameMode = 'duel'): Side[] {
  // Both racers face the same way; there is one finish line, not two goals.
  if (mode === 'race') return [Side.South, Side.South];
  return players === 2
    ? [Side.South, Side.North]
    : [Side.South, Side.North, Side.West, Side.East];
}

export function startPos(side: Side, rows: number, cols = rows): Pos {
  const midRow = (rows - 1) >> 1;
  const midCol = (cols - 1) >> 1;
  switch (side) {
    case Side.South:
      return { r: rows - 1, c: midCol };
    case Side.North:
      return { r: 0, c: midCol };
    case Side.West:
      return { r: midRow, c: 0 };
    case Side.East:
      return { r: midRow, c: cols - 1 };
  }
}

/**
 * Where the racers line up: both on the bottom row, spaced evenly either side
 * of centre so neither starts with a shorter route than the other.
 */
export function raceStartPos(seat: number, rows: number, cols: number): Pos {
  const inset = Math.max(1, Math.floor(cols / 4));
  return { r: rows - 1, c: seat === 0 ? inset : cols - 1 - inset };
}

export function isGoal(side: Side, r: number, c: number, rows: number, cols = rows): boolean {
  switch (side) {
    case Side.South:
      return r === 0;
    case Side.North:
      return r === rows - 1;
    case Side.West:
      return c === cols - 1;
    case Side.East:
      return c === 0;
  }
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.r === b.r && a.c === b.c;
}

export function sameWall(a: Wall, b: Wall): boolean {
  return a.r === b.r && a.c === b.c && a.o === b.o;
}

export function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === MoveKind.Step) return samePos(a.to, (b as typeof a).to);
  return sameWall(a.wall, (b as { wall: Wall }).wall);
}

export function cloneConfig(partial?: Partial<GameConfig>): GameConfig {
  const merged: GameConfig = { ...DEFAULT_CONFIG, ...partial };
  if (partial && partial.wallsPerPlayer === undefined) {
    merged.wallsPerPlayer = defaultWallsFor(merged.players, merged.size, merged.mode);
  }
  return merged;
}

/** Result of a legality check, with a machine-readable reason on failure. */
export type LegalityResult =
  | { ok: true }
  | { ok: false; reason: IllegalReason };

export type IllegalReason =
  | 'game-over'
  | 'not-your-turn'
  | 'out-of-bounds'
  | 'blocked'
  | 'occupied'
  | 'no-walls-left'
  | 'wall-overlap'
  | 'wall-crosses'
  | 'wall-traps'
  | 'unreachable';

const OUT_OF_BOUNDS: LegalityResult = { ok: false, reason: 'out-of-bounds' };

export class Game {
  readonly config: GameConfig;
  /** Board width. Named `size` for the many square boards that came first. */
  readonly size: number;
  readonly cols: number;
  readonly rows: number;

  players: PlayerState[];
  walls: Wall[] = [];
  turn: PlayerIndex = 0;
  ply = 0;
  winner: PlayerIndex | null = null;
  ending: GameState['ending'] = null;
  history: GameState['history'] = [];

  private hBlock: Uint8Array;
  private vBlock: Uint8Array;
  private wallAt: Uint8Array;

  // Scratch buffers reused by the BFS so search does not allocate.
  private bfsDist: Int16Array;
  private bfsQueue: Int16Array;
  private occ: Int8Array;

  constructor(config?: Partial<GameConfig>) {
    this.config = cloneConfig(config);
    const cols = (this.cols = this.size = this.config.size);
    const rows = (this.rows = rowsFor(this.config));
    const cells = rows * cols;
    this.hBlock = new Uint8Array(cells);
    this.vBlock = new Uint8Array(cells);
    this.wallAt = new Uint8Array((rows - 1) * (cols - 1));
    this.bfsDist = new Int16Array(cells);
    this.bfsQueue = new Int16Array(cells);
    this.occ = new Int8Array(cells);

    const race = this.config.mode === 'race';
    const sides = sidesFor(this.config.players, this.config.mode);
    this.players = sides.map((side, index) => ({
      index,
      side,
      pos: race ? raceStartPos(index, rows, cols) : startPos(side, rows, cols),
      walls: this.config.wallsPerPlayer,
      finished: false,
      rank: 0,
      eliminated: false,
    }));
    this.refreshOccupancy();
  }

  // ---------------------------------------------------------------- geometry

  private idx(r: number, c: number): number {
    return r * this.cols + c;
  }

  inBounds(r: number, c: number): boolean {
    return r >= 0 && c >= 0 && r < this.rows && c < this.cols;
  }

  /** True when a wall blocks the step from (r,c) to (r+dr,c+dc). */
  blocked(r: number, c: number, dr: number, dc: number): boolean {
    if (dr === -1) return this.hBlock[this.idx(r - 1, c)] === 1;
    if (dr === 1) return this.hBlock[this.idx(r, c)] === 1;
    if (dc === -1) return this.vBlock[this.idx(r, c - 1)] === 1;
    return this.vBlock[this.idx(r, c)] === 1;
  }

  private refreshOccupancy(): void {
    this.occ.fill(-1);
    for (const p of this.players) {
      if (!p.finished && !p.eliminated) this.occ[this.idx(p.pos.r, p.pos.c)] = p.index;
    }
  }

  /** Seat occupying a cell, or -1. */
  occupantAt(r: number, c: number): number {
    return this.occ[this.idx(r, c)];
  }

  // ------------------------------------------------------------------- walls

  wallKindAt(r: number, c: number): number {
    if (r < 0 || c < 0 || r > this.rows - 2 || c > this.cols - 2) return 0;
    return this.wallAt[r * (this.cols - 1) + c];
  }

  /** Cheap structural check: bounds, crossings and overlaps. No path check. */
  wallShapeLegal(w: Wall): LegalityResult {
    if (w.r < 0 || w.c < 0 || w.r > this.rows - 2 || w.c > this.cols - 2) return OUT_OF_BOUNDS;
    if (this.wallKindAt(w.r, w.c) !== 0) return { ok: false, reason: 'wall-crosses' };
    if (w.o === Orientation.Horizontal) {
      if (this.wallKindAt(w.r, w.c - 1) === 1 || this.wallKindAt(w.r, w.c + 1) === 1)
        return { ok: false, reason: 'wall-overlap' };
    } else {
      if (this.wallKindAt(w.r - 1, w.c) === 2 || this.wallKindAt(w.r + 1, w.c) === 2)
        return { ok: false, reason: 'wall-overlap' };
    }
    return { ok: true };
  }

  private setWall(w: Wall, on: boolean): void {
    const v = on ? 1 : 0;
    const n = this.cols;
    if (w.o === Orientation.Horizontal) {
      this.hBlock[this.idx(w.r, w.c)] = v;
      this.hBlock[this.idx(w.r, w.c + 1)] = v;
    } else {
      this.vBlock[this.idx(w.r, w.c)] = v;
      this.vBlock[this.idx(w.r + 1, w.c)] = v;
    }
    this.wallAt[w.r * (n - 1) + w.c] = on ? (w.o === Orientation.Horizontal ? 1 : 2) : 0;
  }

  /** Full legality: shape + every active player keeps a route to their goal. */
  isWallLegal(w: Wall, by: PlayerIndex): LegalityResult {
    const shape = this.wallShapeLegal(w);
    if (!shape.ok) return shape;
    const player = this.players[by];
    if (!player || player.walls <= 0) return { ok: false, reason: 'no-walls-left' };
    this.setWall(w, true);
    const everyoneCanReach = this.allPlayersHavePath();
    this.setWall(w, false);
    return everyoneCanReach ? { ok: true } : { ok: false, reason: 'wall-traps' };
  }

  private allPlayersHavePath(): boolean {
    for (const p of this.players) {
      if (p.finished || p.eliminated) continue;
      if (this.distanceToGoal(p.pos.r, p.pos.c, p.side) < 0) return false;
    }
    return true;
  }

  // --------------------------------------------------------------- pathfinding

  /**
   * Breadth-first shortest distance from (r,c) to the goal edge of `side`,
   * ignoring pawns (pawns can always be jumped or walked around, so treating
   * them as passable is the standard and stable heuristic).
   * Returns -1 when the goal is unreachable.
   */
  distanceToGoal(r: number, c: number, side: Side): number {
    const rows = this.rows;
    const cols = this.cols;
    const dist = this.bfsDist;
    const queue = this.bfsQueue;
    dist.fill(-1);
    let head = 0;
    let tail = 0;
    const start = this.idx(r, c);
    dist[start] = 0;
    queue[tail++] = start;
    if (isGoal(side, r, c, rows, cols)) return 0;
    while (head < tail) {
      const cur = queue[head++];
      const cr = (cur / cols) | 0;
      const cc = cur - cr * cols;
      const d = dist[cur];
      for (let i = 0; i < 4; i++) {
        const dr = DIRS[i][0];
        const dc = DIRS[i][1];
        const nr = cr + dr;
        const nc = cc + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (dist[ni] !== -1) continue;
        if (this.blocked(cr, cc, dr, dc)) continue;
        dist[ni] = d + 1;
        if (isGoal(side, nr, nc, rows, cols)) return d + 1;
        queue[tail++] = ni;
      }
    }
    return -1;
  }

  distanceFor(seat: PlayerIndex): number {
    const p = this.players[seat];
    return this.distanceToGoal(p.pos.r, p.pos.c, p.side);
  }

  /**
   * One shortest route to the goal, as a list of cells starting at the pawn.
   * Used for the "show my path" hint in the UI.
   */
  shortestPath(seat: PlayerIndex): Pos[] {
    const p = this.players[seat];
    const rows = this.rows;
    const cols = this.cols;
    const cells = rows * cols;
    const dist = new Int16Array(cells).fill(-1);
    const prev = new Int16Array(cells).fill(-1);
    const queue = new Int16Array(cells);
    let head = 0;
    let tail = 0;
    const start = this.idx(p.pos.r, p.pos.c);
    dist[start] = 0;
    queue[tail++] = start;
    let goalCell = isGoal(p.side, p.pos.r, p.pos.c, rows, cols) ? start : -1;
    while (head < tail && goalCell === -1) {
      const cur = queue[head++];
      const cr = (cur / cols) | 0;
      const cc = cur - cr * cols;
      for (let i = 0; i < 4; i++) {
        const dr = DIRS[i][0];
        const dc = DIRS[i][1];
        const nr = cr + dr;
        const nc = cc + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (dist[ni] !== -1) continue;
        if (this.blocked(cr, cc, dr, dc)) continue;
        dist[ni] = dist[cur] + 1;
        prev[ni] = cur;
        if (isGoal(p.side, nr, nc, rows, cols)) {
          goalCell = ni;
          break;
        }
        queue[tail++] = ni;
      }
    }
    if (goalCell === -1) return [];
    const out: Pos[] = [];
    for (let cell = goalCell; cell !== -1; cell = prev[cell]) {
      out.push({ r: (cell / cols) | 0, c: cell % cols });
    }
    return out.reverse();
  }

  // ----------------------------------------------------------------- movement

  /** Legal destination cells for a seat's pawn, including jumps. */
  pawnMoves(seat: PlayerIndex): Pos[] {
    const p = this.players[seat];
    const out: Pos[] = [];
    const { r, c } = p.pos;
    for (let i = 0; i < 4; i++) {
      const dr = DIRS[i][0];
      const dc = DIRS[i][1];
      const nr = r + dr;
      const nc = c + dc;
      if (!this.inBounds(nr, nc)) continue;
      if (this.blocked(r, c, dr, dc)) continue;
      if (this.occupantAt(nr, nc) === -1) {
        out.push({ r: nr, c: nc });
        continue;
      }
      // A pawn is in the way: try to hop straight over it first.
      const jr = nr + dr;
      const jc = nc + dc;
      const straightOk =
        this.inBounds(jr, jc) &&
        !this.blocked(nr, nc, dr, dc) &&
        this.occupantAt(jr, jc) === -1;
      if (straightOk) {
        out.push({ r: jr, c: jc });
        continue;
      }
      // Straight hop unavailable — sidestep diagonally around the blocker.
      for (const [pr, pc] of PERP[i]) {
        const dr2 = nr + pr;
        const dc2 = nc + pc;
        if (!this.inBounds(dr2, dc2)) continue;
        if (this.blocked(nr, nc, pr, pc)) continue;
        if (this.occupantAt(dr2, dc2) !== -1) continue;
        if (!out.some((m) => m.r === dr2 && m.c === dc2)) out.push({ r: dr2, c: dc2 });
      }
    }
    return out;
  }

  isStepLegal(to: Pos, seat: PlayerIndex): LegalityResult {
    if (!this.inBounds(to.r, to.c)) return OUT_OF_BOUNDS;
    const moves = this.pawnMoves(seat);
    return moves.some((m) => m.r === to.r && m.c === to.c)
      ? { ok: true }
      : { ok: false, reason: 'blocked' };
  }

  isLegal(move: Move, seat: PlayerIndex = this.turn): LegalityResult {
    if (this.winner !== null || this.ending) return { ok: false, reason: 'game-over' };
    if (seat !== this.turn) return { ok: false, reason: 'not-your-turn' };
    return move.kind === MoveKind.Step
      ? this.isStepLegal(move.to, seat)
      : this.isWallLegal(move.wall, seat);
  }

  /**
   * Every legal move for the seat on turn. Pawn steps first, then walls.
   *
   * A finished game has none. `apply` already refuses with `game-over`, but a
   * list called "legal moves" that `apply` would reject is a trap for the next
   * caller — the answer and the rule have to agree.
   */
  legalMoves(seat: PlayerIndex = this.turn): Move[] {
    if (this.isOver) return [];
    const out: Move[] = this.pawnMoves(seat).map((to) => ({ kind: MoveKind.Step, to } as Move));
    if (this.players[seat].walls > 0) {
      for (const w of this.candidateWalls()) {
        if (this.isWallLegal(w, seat).ok) out.push({ kind: MoveKind.Wall, wall: w });
      }
    }
    return out;
  }

  /** All structurally-placeable walls (cheap filter, no path check). */
  candidateWalls(): Wall[] {
    const out: Wall[] = [];
    for (let r = 0; r <= this.rows - 2; r++) {
      for (let c = 0; c <= this.cols - 2; c++) {
        for (let o = 0 as 0 | 1; o <= 1; o = (o + 1) as 0 | 1) {
          const w: Wall = { r, c, o };
          if (this.wallShapeLegal(w).ok) out.push(w);
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ apply / undo

  /**
   * Apply a move for the seat currently on turn. Returns the legality result;
   * on failure nothing changes.
   */
  apply(move: Move, elapsedMs = 0): LegalityResult {
    const seat = this.turn;
    const legality = this.isLegal(move, seat);
    if (!legality.ok) return legality;
    const player = this.players[seat];

    if (move.kind === MoveKind.Step) {
      this.occ[this.idx(player.pos.r, player.pos.c)] = -1;
      player.pos = { r: move.to.r, c: move.to.c };
      this.occ[this.idx(player.pos.r, player.pos.c)] = seat;
      if (isGoal(player.side, player.pos.r, player.pos.c, this.rows, this.cols)) {
        player.finished = true;
        player.rank = this.players.filter((p) => p.finished).length;
        this.occ[this.idx(player.pos.r, player.pos.c)] = -1;
        if (this.winner === null) {
          this.winner = seat;
          this.ending = 'goal';
        }
      }
    } else {
      this.setWall(move.wall, true);
      this.walls.push({ ...move.wall });
      player.walls -= 1;
    }

    this.history.push({ move, by: seat, ms: elapsedMs });
    this.ply += 1;
    if (this.winner === null) this.advanceTurn();
    return { ok: true };
  }

  private advanceTurn(): void {
    const total = this.players.length;
    for (let i = 1; i <= total; i++) {
      const next = (this.turn + i) % total;
      const p = this.players[next];
      if (!p.finished && !p.eliminated) {
        this.turn = next;
        return;
      }
    }
    // Nobody can move — the game is over.
    this.ending = this.ending ?? 'draw';
  }

  /** Mark a seat as out (resignation, timeout, disconnection). */
  eliminate(seat: PlayerIndex, ending: GameState['ending']): void {
    const p = this.players[seat];
    if (!p || p.eliminated || p.finished) return;
    p.eliminated = true;
    this.occ[this.idx(p.pos.r, p.pos.c)] = -1;
    const alive = this.players.filter((x) => !x.eliminated && !x.finished);
    if (this.winner === null) {
      if (alive.length === 1) {
        this.winner = alive[0].index;
        this.ending = ending;
      } else if (alive.length === 0) {
        this.ending = ending;
      }
    }
    if (this.winner === null && this.turn === seat) this.advanceTurn();
  }

  // ------------------------------------------------ fast make/unmake for search

  /**
   * Lightweight mutation used by the bot search. Skips history bookkeeping and
   * returns an undo token. Assumes the move has already been validated.
   */
  makeForSearch(move: Move): SearchUndo {
    const seat = this.turn;
    const player = this.players[seat];
    const undo: SearchUndo = {
      seat,
      turn: this.turn,
      kind: move.kind,
      prev: { r: player.pos.r, c: player.pos.c },
      wall: move.kind === MoveKind.Wall ? move.wall : null,
      finished: player.finished,
      winner: this.winner,
      ending: this.ending,
    };
    if (move.kind === MoveKind.Step) {
      this.occ[this.idx(player.pos.r, player.pos.c)] = -1;
      player.pos = { r: move.to.r, c: move.to.c };
      this.occ[this.idx(player.pos.r, player.pos.c)] = seat;
      if (isGoal(player.side, player.pos.r, player.pos.c, this.rows, this.cols)) {
        player.finished = true;
        this.occ[this.idx(player.pos.r, player.pos.c)] = -1;
        if (this.winner === null) this.winner = seat;
      }
    } else {
      this.setWall(move.wall, true);
      player.walls -= 1;
    }
    // Unlike `apply`, the search *always* hands the turn on — even after a win.
    // Negamax negates every child score, so the side-to-move at a terminal node
    // must still be the opponent or the sign of the mate score flips.
    this.advanceTurn();
    return undo;
  }

  unmakeForSearch(undo: SearchUndo): void {
    const player = this.players[undo.seat];
    if (undo.kind === MoveKind.Step) {
      if (player.finished && !undo.finished) player.finished = false;
      else this.occ[this.idx(player.pos.r, player.pos.c)] = -1;
      player.pos = undo.prev;
      this.occ[this.idx(player.pos.r, player.pos.c)] = undo.seat;
    } else if (undo.wall) {
      this.setWall(undo.wall, false);
      player.walls += 1;
    }
    this.winner = undo.winner;
    this.ending = undo.ending;
    this.turn = undo.turn;
  }

  // ------------------------------------------------------- (de)serialisation

  toState(): GameState {
    return {
      config: this.config,
      players: this.players.map((p) => ({ ...p, pos: { ...p.pos } })),
      walls: this.walls.map((w) => ({ ...w })),
      turn: this.turn,
      ply: this.ply,
      winner: this.winner,
      ending: this.ending,
      history: this.history.map((h) => ({ ...h })),
    };
  }

  static fromState(state: GameState): Game {
    const g = new Game(state.config);
    g.players = state.players.map((p) => ({ ...p, pos: { ...p.pos } }));
    g.walls = [];
    for (const w of state.walls) {
      g.setWall(w, true);
      g.walls.push({ ...w });
    }
    g.turn = state.turn;
    g.ply = state.ply;
    g.winner = state.winner;
    g.ending = state.ending;
    g.history = state.history.map((h) => ({ ...h }));
    g.refreshOccupancy();
    return g;
  }

  clone(): Game {
    return Game.fromState(this.toState());
  }

  /** Deterministic key for transposition tables and repetition checks. */
  positionKey(): string {
    let s = `${this.turn}|`;
    for (const p of this.players) s += `${p.pos.r},${p.pos.c},${p.walls},${p.finished ? 1 : 0};`;
    s += '|';
    const sorted = [...this.walls].sort((a, b) => a.r - b.r || a.c - b.c || a.o - b.o);
    for (const w of sorted) s += `${w.r}${w.c}${w.o},`;
    return s;
  }

  get isOver(): boolean {
    return this.winner !== null || this.ending !== null;
  }
}

export interface SearchUndo {
  seat: PlayerIndex;
  turn: PlayerIndex;
  kind: MoveKind;
  prev: Pos;
  wall: Wall | null;
  finished: boolean;
  winner: PlayerIndex | null;
  ending: GameState['ending'];
}
