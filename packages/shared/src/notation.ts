/**
 * WallRush — move notation.
 *
 * We use the notation the Quoridor community already reads: files are letters
 * from the left (a, b, c …), ranks are numbers from the bottom (1, 2, 3 …).
 * A pawn move is just its destination square, e.g. `e8`. A wall is its
 * anchor square plus `h` or `v`, e.g. `e3h`.
 *
 * The anchor of a wall is the square to the *lower left* of the intersection it
 * sits on, which matches how the physical board is described.
 */

import { MoveKind, type Move, type Wall, type Pos } from './types.js';

const FILES = 'abcdefghijklmnop';

export function fileOf(c: number): string {
  return FILES[c] ?? '?';
}

export function rankOf(r: number, rows: number): number {
  return rows - r;
}

export function squareName(pos: Pos, rows: number): string {
  return `${fileOf(pos.c)}${rankOf(pos.r, rows)}`;
}

export function wallName(w: Wall, rows: number): string {
  // Intersection (r,c) sits between rows r/r+1 and columns c/c+1. Its anchor
  // square is the cell below-left of the intersection: (r+1, c).
  return `${fileOf(w.c)}${rankOf(w.r + 1, rows)}${w.o === 0 ? 'h' : 'v'}`;
}

/**
 * Names carry the board height, not its width: a rank counts up from the
 * bottom, and a race track is taller than it is wide.
 */
export function moveName(move: Move, rows: number): string {
  return move.kind === MoveKind.Step
    ? squareName(move.to, rows)
    : wallName(move.wall, rows);
}

export function parseMove(text: string, rows: number, cols = rows): Move | null {
  const t = text.trim().toLowerCase();
  const m = /^([a-p])(\d{1,2})([hv])?$/.exec(t);
  if (!m) return null;
  const c = FILES.indexOf(m[1]);
  const rank = Number(m[2]);
  if (c < 0 || c >= cols || rank < 1 || rank > rows) return null;
  const r = rows - rank;
  if (!m[3]) return { kind: MoveKind.Step, to: { r, c } };
  const wr = r - 1;
  if (wr < 0 || wr > rows - 2 || c > cols - 2) return null;
  return { kind: MoveKind.Wall, wall: { r: wr, c, o: m[3] === 'h' ? 0 : 1 } };
}

/** Full game transcript, one token per half-move. */
export function transcript(moves: Move[], rows: number): string {
  return moves.map((m) => moveName(m, rows)).join(' ');
}

export function parseTranscript(text: string, rows: number, cols = rows): Move[] {
  const out: Move[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const move = parseMove(token, rows, cols);
    if (move) out.push(move);
  }
  return out;
}
