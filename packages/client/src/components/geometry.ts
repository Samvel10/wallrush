/**
 * Board geometry.
 *
 * Every element is placed with percentages inside a container whose aspect
 * ratio matches the board, so it is resolution independent: no canvas, no
 * resize listeners, no layout thrash. One "unit" is a cell; the gap between
 * cells is a fraction of a cell and is exactly where walls live.
 *
 * The two axes are measured separately because a board need not be square —
 * a race is run on a track that is taller than it is wide — and a percentage
 * of the width is not the same length as a percentage of the height.
 */

export interface Axis {
  /** Length of one cell along this axis, in percent of the board. */
  cell: number;
  /** Length of the gap between two cells, in percent of the board. */
  gap: number;
  /** Distance from one cell's start to the next cell's start. */
  pitch: number;
  /** How many cells this axis has. */
  count: number;
}

export interface BoardMetrics {
  /** Horizontal axis, measured in percent of the board's width. */
  x: Axis;
  /** Vertical axis, measured in percent of the board's height. */
  y: Axis;
  rows: number;
  cols: number;
}

export const GAP_RATIO = 0.2;

/**
 * How far a wall slot's touch target grows past the visible gap, as a fraction
 * of a cell. A 20 %-of-a-cell gap is roughly 7 px on a phone; growing it by
 * 0.42 of a cell brings the target to a comfortable ~22 px without changing
 * how the board looks.
 */
export const SLOT_GROW = 0.42;

/**
 * The visible bar inside a slot, as a percentage of the slot's own box. Both
 * the gap and the growth scale with the cell, so this ratio is constant for
 * every board size.
 */
export const SLOT_THICKNESS_PCT = (GAP_RATIO / (GAP_RATIO + SLOT_GROW)) * 100;

function axisFor(count: number, gapRatio: number): Axis {
  const units = count + (count - 1) * gapRatio;
  const cell = 100 / units;
  const gap = cell * gapRatio;
  return { cell, gap, pitch: cell + gap, count };
}

export function metricsFor(rows: number, cols = rows, gapRatio = GAP_RATIO): BoardMetrics {
  return { x: axisFor(cols, gapRatio), y: axisFor(rows, gapRatio), rows, cols };
}

export interface Box {
  left: string;
  top: string;
  width: string;
  height: string;
}

export function cellBox(m: BoardMetrics, r: number, c: number): Box {
  return {
    left: `${c * m.x.pitch}%`,
    top: `${r * m.y.pitch}%`,
    width: `${m.x.cell}%`,
    height: `${m.y.cell}%`,
  };
}

/** Centre of a cell, as percentages — handy for pawns and floating effects. */
export function cellCentre(m: BoardMetrics, r: number, c: number): { x: number; y: number } {
  return { x: c * m.x.pitch + m.x.cell / 2, y: r * m.y.pitch + m.y.cell / 2 };
}

/** The visual footprint of a wall at intersection (r, c). */
export function wallBox(m: BoardMetrics, r: number, c: number, orientation: 0 | 1): Box {
  if (orientation === 0) {
    return {
      left: `${c * m.x.pitch}%`,
      top: `${r * m.y.pitch + m.y.cell}%`,
      width: `${2 * m.x.cell + m.x.gap}%`,
      height: `${m.y.gap}%`,
    };
  }
  return {
    left: `${c * m.x.pitch + m.x.cell}%`,
    top: `${r * m.y.pitch}%`,
    width: `${m.x.gap}%`,
    height: `${2 * m.y.cell + m.y.gap}%`,
  };
}

/**
 * The touch target for a wall slot. Deliberately fatter than the wall itself —
 * a 20 %-of-a-cell gap is only about 7 px on a phone, far below a comfortable
 * tap target, so we grow the hit area perpendicular to the wall and let the
 * visible bar stay slim inside it.
 */
export function slotBox(m: BoardMetrics, r: number, c: number, orientation: 0 | 1): Box {
  if (orientation === 0) {
    const grow = m.y.cell * SLOT_GROW;
    return {
      left: `${c * m.x.pitch}%`,
      top: `${r * m.y.pitch + m.y.cell - grow / 2}%`,
      width: `${2 * m.x.cell + m.x.gap}%`,
      height: `${m.y.gap + grow}%`,
    };
  }
  const grow = m.x.cell * SLOT_GROW;
  return {
    left: `${c * m.x.pitch + m.x.cell - grow / 2}%`,
    top: `${r * m.y.pitch}%`,
    width: `${m.x.gap + grow}%`,
    height: `${2 * m.y.cell + m.y.gap}%`,
  };
}

/** Map a pointer position inside the board to the nearest wall intersection. */
export function nearestSlot(
  m: BoardMetrics,
  xPct: number,
  yPct: number,
  orientation: 0 | 1,
): { r: number; c: number } | null {
  const maxRow = m.rows - 2;
  const maxCol = m.cols - 2;
  if (orientation === 0) {
    // Horizontal walls sit on a row boundary and span two columns.
    const r = Math.round(yPct / m.y.pitch) - 1;
    const c = Math.round(xPct / m.x.pitch - 0.5);
    if (r < 0 || c < 0 || r > maxRow || c > maxCol) return null;
    return { r, c };
  }
  const c = Math.round(xPct / m.x.pitch) - 1;
  const r = Math.round(yPct / m.y.pitch - 0.5);
  if (r < 0 || c < 0 || r > maxRow || c > maxCol) return null;
  return { r, c };
}

export function seatColorVar(seat: number): string {
  return `var(--p${seat})`;
}

export function seatDeepVar(seat: number): string {
  return `var(--p${seat}-deep)`;
}
