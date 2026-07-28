/**
 * WallRush — core domain types.
 *
 * The board is an N×N grid of cells (N = 9 by default). Walls are placed on the
 * (N-1)×(N-1) grid of *intersections* between cells and always span two cell
 * borders, exactly like in Quoridor.
 */

/** Board side length. Classic Quoridor is 9; we also support 5 and 7 for fast games. */
export type BoardSize = 5 | 7 | 9 | 11;

/** Wall orientation. */
export enum Orientation {
  /** Spans horizontally: blocks vertical movement between row r and r+1. */
  Horizontal = 0,
  /** Spans vertically: blocks horizontal movement between col c and c+1. */
  Vertical = 1,
}

export type OrientationLike = 0 | 1;

/** A cell on the board. */
export interface Pos {
  r: number;
  c: number;
}

/** A wall anchored at intersection (r, c), 0 <= r,c <= size-2. */
export interface Wall {
  r: number;
  c: number;
  o: OrientationLike;
}

/** Which edge of the board a player starts from (and therefore which one they must reach). */
export enum Side {
  South = 0, // starts at bottom row, must reach row 0
  North = 1, // starts at top row, must reach row size-1
  West = 2, // starts at left column, must reach column size-1
  East = 3, // starts at right column, must reach column 0
}

export type PlayerIndex = number;

export interface PlayerState {
  /** Seat index 0..players-1. */
  readonly index: PlayerIndex;
  /** Which board edge this seat is anchored to. */
  readonly side: Side;
  /** Current pawn position. */
  pos: Pos;
  /** Walls still in hand. */
  walls: number;
  /** True once this player has reached their goal edge. */
  finished: boolean;
  /** Finishing order (1 = first). 0 while unfinished. */
  rank: number;
  /** True when the player resigned or timed out. */
  eliminated: boolean;
}

export enum MoveKind {
  Step = 0,
  Wall = 1,
}

export interface StepMove {
  kind: MoveKind.Step;
  to: Pos;
}

export interface WallMove {
  kind: MoveKind.Wall;
  wall: Wall;
}

export type Move = StepMove | WallMove;

/**
 * How the pawns are placed and where they are running.
 *
 * `duel` is the classic: start on opposite sides, reach the side you came
 * from being the one you did not. `race` starts both players on the *same*
 * edge, side by side, running for one shared finish line — a foot race with
 * walls rather than a duel, and it plays completely differently.
 */
export type GameMode = 'duel' | 'race';

export interface GameConfig {
  /** Board width in cells. */
  size: BoardSize;
  /**
   * Board height in cells. Defaults to `size` — a square board — because a
   * duel is symmetric. A race wants a long track, so it is taller than wide.
   */
  rows?: number;
  mode?: GameMode;
  /** 2 or 4 seats. */
  players: 2 | 4;
  /** Walls handed to each player at the start. */
  wallsPerPlayer: number;
  /** Total thinking time per player in milliseconds (0 = unlimited). */
  clockMs: number;
  /** Increment added after each move, in milliseconds. */
  incrementMs: number;
  /** Hard cap for a single move in milliseconds (0 = unlimited). */
  moveTimeoutMs: number;
}

export interface GameState {
  readonly config: GameConfig;
  players: PlayerState[];
  /** Placed walls, in placement order. */
  walls: Wall[];
  /** Seat index whose turn it is. */
  turn: PlayerIndex;
  /** Half-move counter. */
  ply: number;
  /** Set once the game is over. */
  winner: PlayerIndex | null;
  /** Why the game ended. */
  ending: GameEnding | null;
  /** Full move history for replay/notation. */
  history: HistoryEntry[];
}

export type GameEnding =
  | 'goal'
  | 'resign'
  | 'timeout'
  | 'disconnect'
  | 'draw'
  | 'abort';

export interface HistoryEntry {
  move: Move;
  by: PlayerIndex;
  /** Milliseconds spent on this move. */
  ms: number;
  /** Shortest-path distances for every player *after* the move (for analysis). */
  dist?: number[];
}

export const DEFAULT_CONFIG: GameConfig = {
  size: 9,
  mode: 'duel',
  players: 2,
  wallsPerPlayer: 10,
  clockMs: 5 * 60 * 1000,
  incrementMs: 2000,
  moveTimeoutMs: 30 * 1000,
};

/** Bot strength presets, weakest to strongest. */
export type BotLevel =
  | 'novice'
  | 'easy'
  | 'medium'
  | 'hard'
  | 'expert'
  | 'master';

export const BOT_LEVELS: BotLevel[] = [
  'novice',
  'easy',
  'medium',
  'hard',
  'expert',
  'master',
];
