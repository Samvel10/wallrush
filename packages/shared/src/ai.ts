/**
 * WallRush — bot engine.
 *
 * A negamax search with alpha–beta pruning, iterative deepening, a Zobrist
 * transposition table and heuristic move ordering. Wall candidates are filtered
 * down to the handful that actually matter (near a pawn or on somebody's
 * shortest route), which is what makes a deep search affordable in a browser.
 *
 * Weaker levels are not a crippled search — they are a *differently shaped*
 * player: shallower horizon, fewer wall ideas, and a controlled amount of
 * human-like inaccuracy. That keeps beginner bots beatable without making them
 * feel broken.
 */

import { Game, isGoal } from './engine.js';
import {
  MoveKind,
  type BotLevel,
  type Move,
  type PlayerIndex,
  type Wall,
} from './types.js';

const INF = 1_000_000;
const WIN = 100_000;

export interface BotProfile {
  level: BotLevel;
  /** Nominal search depth in plies. */
  depth: number;
  /** Milliseconds the search may spend. */
  timeMs: number;
  /** Wall candidates considered at the root. */
  rootWalls: number;
  /** Wall candidates considered at inner nodes. */
  innerWalls: number;
  /** Probability of deliberately playing a non-optimal move. */
  blunder: number;
  /** How far down the ranked list a blunder may reach. */
  blunderSpread: number;
  /** Probability of skipping wall moves entirely on a given turn. */
  wallShyness: number;
  /** Minimum visible "thinking" time, so the bot does not feel robotic. */
  minThinkMs: number;
}

export const BOT_PROFILES: Record<BotLevel, BotProfile> = {
  novice: {
    level: 'novice',
    depth: 1,
    timeMs: 60,
    rootWalls: 6,
    innerWalls: 0,
    blunder: 0.55,
    blunderSpread: 6,
    wallShyness: 0.75,
    minThinkMs: 420,
  },
  easy: {
    level: 'easy',
    depth: 2,
    timeMs: 140,
    rootWalls: 10,
    innerWalls: 3,
    blunder: 0.3,
    blunderSpread: 4,
    wallShyness: 0.45,
    minThinkMs: 380,
  },
  medium: {
    level: 'medium',
    depth: 3,
    timeMs: 400,
    rootWalls: 18,
    innerWalls: 6,
    blunder: 0.12,
    blunderSpread: 3,
    wallShyness: 0.15,
    minThinkMs: 340,
  },
  hard: {
    level: 'hard',
    depth: 4,
    timeMs: 900,
    rootWalls: 26,
    innerWalls: 8,
    blunder: 0.04,
    blunderSpread: 2,
    wallShyness: 0.04,
    minThinkMs: 300,
  },
  expert: {
    level: 'expert',
    depth: 5,
    timeMs: 1800,
    rootWalls: 34,
    innerWalls: 10,
    blunder: 0,
    blunderSpread: 1,
    wallShyness: 0,
    minThinkMs: 260,
  },
  master: {
    level: 'master',
    depth: 8,
    timeMs: 3200,
    rootWalls: 48,
    innerWalls: 14,
    blunder: 0,
    blunderSpread: 1,
    wallShyness: 0,
    minThinkMs: 200,
  },
};

export interface SearchResult {
  move: Move;
  score: number;
  depth: number;
  nodes: number;
  ms: number;
  /** Principal variation, best first. */
  pv: Move[];
}

// ------------------------------------------------------------------ Zobrist

const RNG_SEED = 0x9e3779b9;

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}

interface ZobristTables {
  pawn: Uint32Array; // [seat][cell]
  wall: Uint32Array; // [slot*2 + orientation]
  hand: Uint32Array; // [seat][wallsLeft]
  turn: Uint32Array; // [seat]
  cells: number;
  maxHand: number;
}

const zobristCache = new Map<string, ZobristTables>();

function zobristFor(size: number, seats: number): ZobristTables {
  const key = `${size}:${seats}`;
  const cached = zobristCache.get(key);
  if (cached) return cached;
  const rng = makeRng(RNG_SEED ^ (size * 131 + seats));
  const cells = size * size;
  const slots = (size - 1) * (size - 1);
  const maxHand = 21;
  const tables: ZobristTables = {
    pawn: new Uint32Array(seats * cells),
    wall: new Uint32Array(slots * 2),
    hand: new Uint32Array(seats * maxHand),
    turn: new Uint32Array(seats),
    cells,
    maxHand,
  };
  for (const arr of [tables.pawn, tables.wall, tables.hand, tables.turn]) {
    for (let i = 0; i < arr.length; i++) arr[i] = rng();
  }
  zobristCache.set(key, tables);
  return tables;
}

// ---------------------------------------------------------- transposition TT

const TT_BITS = 17; // 131k entries
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

enum Bound {
  Exact = 0,
  Lower = 1,
  Upper = 2,
}

class TranspositionTable {
  private keys = new Int32Array(TT_SIZE);
  private scores = new Int32Array(TT_SIZE);
  private depths = new Int8Array(TT_SIZE);
  private bounds = new Uint8Array(TT_SIZE);
  private moves: (Move | null)[] = new Array(TT_SIZE).fill(null);
  private used = new Uint8Array(TT_SIZE);
  private generation = 0;

  newSearch(): void {
    this.generation = (this.generation + 1) & 0xff;
  }

  clear(): void {
    this.used.fill(0);
    this.moves.fill(null);
  }

  probe(hash: number): {
    hit: boolean;
    score: number;
    depth: number;
    bound: Bound;
    move: Move | null;
  } {
    const i = hash & TT_MASK;
    if (this.used[i] === 0 || this.keys[i] !== (hash | 0)) {
      return { hit: false, score: 0, depth: -1, bound: Bound.Exact, move: null };
    }
    return {
      hit: true,
      score: this.scores[i],
      depth: this.depths[i],
      bound: this.bounds[i] as Bound,
      move: this.moves[i],
    };
  }

  store(hash: number, score: number, depth: number, bound: Bound, move: Move | null): void {
    const i = hash & TT_MASK;
    if (this.used[i] === 1 && this.keys[i] === (hash | 0) && this.depths[i] > depth) return;
    this.used[i] = 1;
    this.keys[i] = hash | 0;
    this.scores[i] = score;
    this.depths[i] = depth;
    this.bounds[i] = bound;
    this.moves[i] = move;
  }
}

// ------------------------------------------------------------------- the bot

export class Bot {
  readonly profile: BotProfile;
  private tt = new TranspositionTable();
  private z: ZobristTables;
  private rng: () => number;
  private nodes = 0;
  private deadline = 0;
  private aborted = false;
  private killers: (Move | null)[][] = [];

  constructor(
    level: BotLevel | BotProfile = 'medium',
    private size = 9,
    seats = 2,
    seed = 0x2545f491,
  ) {
    this.profile = typeof level === 'string' ? BOT_PROFILES[level] : level;
    this.z = zobristFor(size, seats);
    this.rng = makeRng(seed >>> 0 || 1);
  }

  private random(): number {
    return this.rng() / 0x100000000;
  }

  // ------------------------------------------------------------- hashing

  private hashOf(g: Game): number {
    let h = this.z.turn[g.turn] >>> 0;
    for (const p of g.players) {
      h = (h ^ this.z.pawn[p.index * this.z.cells + p.pos.r * g.size + p.pos.c]) >>> 0;
      const hand = Math.min(p.walls, this.z.maxHand - 1);
      h = (h ^ this.z.hand[p.index * this.z.maxHand + hand]) >>> 0;
    }
    for (const w of g.walls) {
      h = (h ^ this.z.wall[(w.r * (g.size - 1) + w.c) * 2 + w.o]) >>> 0;
    }
    return h >>> 0;
  }

  // ---------------------------------------------------------- evaluation

  /**
   * Static evaluation from the perspective of `me`. Positive is good for `me`.
   * The dominant term is the race: how many steps I need versus my closest
   * rival. Walls in hand, board progress and centre control are tie-breakers.
   */
  evaluate(g: Game, me: PlayerIndex): number {
    const myPlayer = g.players[me];
    const myDist = g.distanceToGoal(myPlayer.pos.r, myPlayer.pos.c, myPlayer.side);
    if (myPlayer.finished || myDist === 0) return WIN - g.ply;
    if (myDist < 0) return -WIN + g.ply;

    let bestOppDist = Infinity;
    let oppWalls = 0;
    let oppCount = 0;
    for (const p of g.players) {
      if (p.index === me || p.eliminated) continue;
      if (p.finished) return -WIN + g.ply;
      const d = g.distanceToGoal(p.pos.r, p.pos.c, p.side);
      if (d === 0) return -WIN + g.ply;
      if (d >= 0 && d < bestOppDist) bestOppDist = d;
      oppWalls += p.walls;
      oppCount += 1;
    }
    if (!isFinite(bestOppDist)) return WIN - g.ply;
    const avgOppWalls = oppCount > 0 ? oppWalls / oppCount : 0;

    // Race term: every step of advantage is worth a lot.
    let score = (bestOppDist - myDist) * 110;

    // Walls are ammunition; they matter more while the race is close.
    const tension = Math.max(0, 14 - Math.abs(bestOppDist - myDist));
    score += (myPlayer.walls - avgOppWalls) * (7 + tension * 0.9);

    // Prefer being closer to the goal in absolute terms — it shortens the game
    // when we are ahead and keeps pressure on when we are behind.
    score -= myDist * 3;

    // Mild centre preference: central files have more escape routes.
    const mid = (g.size - 1) / 2;
    score -= Math.abs(myPlayer.pos.c - mid) * 1.2;

    // Having the move is worth roughly half a step.
    if (g.turn === me) score += 45;
    return Math.round(score);
  }

  // ------------------------------------------------------- move generation

  /**
   * Walls worth thinking about: those touching a pawn's neighbourhood or lying
   * across somebody's current shortest route. Everything else is noise.
   */
  private relevantWalls(g: Game, limit: number, me: PlayerIndex): Wall[] {
    if (limit <= 0) return [];
    const n = g.size;
    const interest = new Uint8Array((n - 1) * (n - 1));
    const mark = (r: number, c: number, radius: number, weight: number) => {
      for (let rr = r - radius; rr <= r + radius; rr++) {
        for (let cc = c - radius; cc <= c + radius; cc++) {
          if (rr < 0 || cc < 0 || rr > n - 2 || cc > n - 2) continue;
          const i = rr * (n - 1) + cc;
          interest[i] = Math.min(255, interest[i] + weight);
        }
      }
    };
    for (const p of g.players) {
      if (p.eliminated || p.finished) continue;
      const weight = p.index === me ? 3 : 6;
      mark(p.pos.r, p.pos.c, 2, weight);
      mark(p.pos.r - 1, p.pos.c - 1, 0, weight);
      const path = g.shortestPath(p.index);
      for (const cell of path) mark(cell.r, cell.c, 1, p.index === me ? 2 : 5);
    }

    const scored: { w: Wall; s: number }[] = [];
    for (let r = 0; r <= n - 2; r++) {
      for (let c = 0; c <= n - 2; c++) {
        const base = interest[r * (n - 1) + c];
        if (base === 0) continue;
        for (let o = 0 as 0 | 1; o <= 1; o = (o + 1) as 0 | 1) {
          const w: Wall = { r, c, o };
          if (!g.wallShapeLegal(w).ok) continue;
          scored.push({ w, s: base });
        }
      }
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, Math.min(limit * 2, scored.length)).map((x) => x.w);
  }

  /**
   * Ordered legal moves for the side to move. Pawn steps that shorten our route
   * come first, then walls ranked by how much they hurt the leading rival.
   */
  private orderedMoves(
    g: Game,
    depthLeft: number,
    ttMove: Move | null,
    ply: number,
  ): Move[] {
    const seat = g.turn;
    const player = g.players[seat];
    const myDist = g.distanceToGoal(player.pos.r, player.pos.c, player.side);

    const scored: { m: Move; s: number }[] = [];

    for (const to of g.pawnMoves(seat)) {
      const d = isGoal(player.side, to.r, to.c, g.size)
        ? 0
        : g.distanceToGoal(to.r, to.c, player.side);
      const gain = d < 0 ? -50 : myDist - d;
      scored.push({ m: { kind: MoveKind.Step, to }, s: 1000 + gain * 100 });
    }

    const wallBudget = depthLeft >= 3 ? this.profile.rootWalls : this.profile.innerWalls;
    if (player.walls > 0 && wallBudget > 0) {
      const candidates = this.relevantWalls(g, wallBudget, seat);
      const wallScored: { m: Move; s: number }[] = [];
      for (const w of candidates) {
        if (!g.isWallLegal(w, seat).ok) continue;
        // How much does this wall cost the strongest rival, and cost me?
        const undo = g.makeForSearch({ kind: MoveKind.Wall, wall: w });
        let worstOpp = Infinity;
        for (const p of g.players) {
          if (p.index === seat || p.eliminated || p.finished) continue;
          const d = g.distanceToGoal(p.pos.r, p.pos.c, p.side);
          if (d >= 0 && d < worstOpp) worstOpp = d;
        }
        const myAfter = g.distanceToGoal(player.pos.r, player.pos.c, player.side);
        g.unmakeForSearch(undo);
        if (!isFinite(worstOpp)) continue;
        const delta = worstOpp * 100 - (myAfter - myDist) * 130;
        wallScored.push({ m: { kind: MoveKind.Wall, wall: w }, s: delta });
      }
      wallScored.sort((a, b) => b.s - a.s);
      for (const entry of wallScored.slice(0, wallBudget)) scored.push(entry);
    }

    const killerRow = this.killers[ply];
    scored.sort((a, b) => b.s - a.s);
    const out = scored.map((x) => x.m);

    // Promote the transposition-table move and killers to the front.
    const promote = (target: Move | null | undefined) => {
      if (!target) return;
      const i = out.findIndex((m) => movesEqual(m, target));
      if (i > 0) out.unshift(out.splice(i, 1)[0]);
    };
    if (killerRow) {
      promote(killerRow[1]);
      promote(killerRow[0]);
    }
    promote(ttMove);
    return out;
  }

  // ------------------------------------------------------------- the search

  private negamax(
    g: Game,
    depth: number,
    alpha: number,
    beta: number,
    me: PlayerIndex,
    ply: number,
    pvOut: Move[],
  ): number {
    if (this.aborted) return 0;
    if ((this.nodes & 0x3ff) === 0 && Date.now() > this.deadline) {
      this.aborted = true;
      return 0;
    }
    this.nodes += 1;

    const perspective = g.turn === me ? 1 : -1;
    if (g.winner !== null) {
      const s = g.winner === me ? WIN - ply : -WIN + ply;
      return s * perspective;
    }
    if (depth <= 0) {
      return this.evaluate(g, me) * perspective;
    }

    const hash = this.hashOf(g);
    const probe = this.tt.probe(hash);
    let ttMove: Move | null = null;
    if (probe.hit) {
      ttMove = probe.move;
      if (probe.depth >= depth) {
        if (probe.bound === Bound.Exact) return probe.score;
        if (probe.bound === Bound.Lower && probe.score > alpha) alpha = probe.score;
        else if (probe.bound === Bound.Upper && probe.score < beta) beta = probe.score;
        if (alpha >= beta) return probe.score;
      }
    }

    const moves = this.orderedMoves(g, depth, ttMove, ply);
    if (moves.length === 0) return this.evaluate(g, me) * perspective;

    const originalAlpha = alpha;
    let best = -INF;
    let bestMove: Move | null = null;
    const childPv: Move[] = [];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const undo = g.makeForSearch(move);
      childPv.length = 0;
      let score: number;
      if (i === 0) {
        score = -this.negamax(g, depth - 1, -beta, -alpha, me, ply + 1, childPv);
      } else {
        // Late-move reduction for the tail of the ordered list.
        const reduction = depth >= 3 && i >= 6 && move.kind === MoveKind.Wall ? 1 : 0;
        score = -this.negamax(
          g,
          depth - 1 - reduction,
          -alpha - 1,
          -alpha,
          me,
          ply + 1,
          childPv,
        );
        if (score > alpha && score < beta) {
          childPv.length = 0;
          score = -this.negamax(g, depth - 1, -beta, -alpha, me, ply + 1, childPv);
        }
      }
      g.unmakeForSearch(undo);
      if (this.aborted) return 0;

      if (score > best) {
        best = score;
        bestMove = move;
        pvOut.length = 0;
        pvOut.push(move, ...childPv);
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (move.kind === MoveKind.Wall) {
          this.killers[ply] = this.killers[ply] ?? [null, null];
          const row = this.killers[ply];
          if (!row[0] || !movesEqual(row[0], move)) {
            row[1] = row[0];
            row[0] = move;
          }
        }
        break;
      }
    }

    const bound =
      best <= originalAlpha ? Bound.Upper : best >= beta ? Bound.Lower : Bound.Exact;
    this.tt.store(hash, best, depth, bound, bestMove);
    return best;
  }

  /**
   * Pick a move for the seat currently on turn.
   * `strict` disables the level's deliberate inaccuracy (used for hints).
   */
  choose(game: Game, opts: { strict?: boolean; timeMs?: number } = {}): SearchResult {
    const started = Date.now();
    const g = game.clone();
    const me = g.turn;
    const profile = this.profile;
    const budget = opts.timeMs ?? profile.timeMs;
    this.deadline = started + budget;
    this.aborted = false;
    this.nodes = 0;
    this.killers = [];
    this.tt.newSearch();

    const strict = opts.strict === true;
    const skipWalls =
      !strict && g.players[me].walls > 0 && this.random() < profile.wallShyness;

    // Rank every root move once, then decide how faithfully to follow the ranking.
    const rootMoves = this.rootCandidates(g, me, skipWalls);
    if (rootMoves.length === 0) {
      const fallback = g.legalMoves(me);
      return {
        move: fallback[0],
        score: 0,
        depth: 0,
        nodes: 0,
        ms: Date.now() - started,
        pv: fallback.slice(0, 1),
      };
    }

    let bestPv: Move[] = [rootMoves[0]];
    let ranking: { move: Move; score: number }[] = rootMoves.map((m) => ({
      move: m,
      score: 0,
    }));
    let reachedDepth = 0;

    for (let depth = 1; depth <= profile.depth; depth++) {
      const results: { move: Move; score: number; pv: Move[] }[] = [];
      let alpha = -INF;
      const ordered = depth === 1 ? rootMoves : ranking.map((r) => r.move);
      for (const move of ordered) {
        const undo = g.makeForSearch(move);
        const childPv: Move[] = [];
        const score = -this.negamax(g, depth - 1, -INF, -alpha, me, 1, childPv);
        g.unmakeForSearch(undo);
        if (this.aborted) break;
        results.push({ move, score, pv: [move, ...childPv] });
        if (score > alpha) alpha = score;
      }
      if (results.length === 0) break;
      if (this.aborted && results.length < ordered.length) {
        // Partial iteration: only trust it if it improved on the previous best.
        results.sort((a, b) => b.score - a.score);
        if (results[0].score > (ranking[0]?.score ?? -INF)) {
          ranking = results.map((r) => ({ move: r.move, score: r.score }));
          bestPv = results[0].pv;
          reachedDepth = depth;
        }
        break;
      }
      results.sort((a, b) => b.score - a.score);
      ranking = results.map((r) => ({ move: r.move, score: r.score }));
      bestPv = results[0].pv;
      reachedDepth = depth;
      if (Math.abs(results[0].score) >= WIN - 1000) break;
      if (Date.now() > this.deadline) break;
    }

    let chosenIndex = 0;
    if (!strict && profile.blunder > 0 && ranking.length > 1) {
      if (this.random() < profile.blunder) {
        const spread = Math.min(profile.blunderSpread, ranking.length - 1);
        chosenIndex = 1 + Math.floor(this.random() * spread);
        if (chosenIndex >= ranking.length) chosenIndex = ranking.length - 1;
      }
    }

    const chosen = ranking[chosenIndex];
    return {
      move: chosen.move,
      score: ranking[0].score,
      depth: reachedDepth,
      nodes: this.nodes,
      ms: Date.now() - started,
      pv: chosenIndex === 0 ? bestPv : [chosen.move],
    };
  }

  private rootCandidates(g: Game, me: PlayerIndex, skipWalls: boolean): Move[] {
    const steps: Move[] = g.pawnMoves(me).map((to) => ({ kind: MoveKind.Step, to }));
    if (skipWalls || g.players[me].walls === 0) return steps;
    const walls = this.relevantWalls(g, this.profile.rootWalls, me)
      .filter((w) => g.isWallLegal(w, me).ok)
      .slice(0, this.profile.rootWalls)
      .map((w) => ({ kind: MoveKind.Wall, wall: w }) as Move);
    return [...steps, ...walls];
  }

  reset(): void {
    this.tt.clear();
  }
}

function movesEqual(a: Move, b: Move): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === MoveKind.Step) {
    const bb = b as typeof a;
    return a.to.r === bb.to.r && a.to.c === bb.to.c;
  }
  const bb = b as { wall: Wall };
  return a.wall.r === bb.wall.r && a.wall.c === bb.wall.c && a.wall.o === bb.wall.o;
}

/** Convenience helper used by the UI hint button. */
export function bestMoveFor(game: Game, level: BotLevel = 'expert'): SearchResult {
  const bot = new Bot(level, game.size, game.config.players);
  return bot.choose(game, { strict: true });
}
