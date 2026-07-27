/**
 * Board geometry.
 *
 * Every element is placed with percentages inside a square container, so the
 * board is resolution independent: no canvas, no resize listeners, no layout
 * thrash. One "unit" is a cell; the gap between cells is a fraction of a cell
 * and is exactly where walls live.
 */

export interface BoardMetrics {
  /** Width/height of one cell, in percent of the board. */
  cell: number;
  /** Width/height of the gap between two cells, in percent of the board. */
  gap: number;
  /** Distance from one cell's start to the next cell's start. */
  pitch: number;
  size: number;
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

export function metricsFor(size: number, gapRatio = GAP_RATIO): BoardMetrics {
  const units = size + (size - 1) * gapRatio;
  const cell = 100 / units;
  const gap = cell * gapRatio;
  return { cell, gap, pitch: cell + gap, size };
}

export interface Box {
  left: string;
  top: string;
  width: string;
  height: string;
}

export function cellBox(m: BoardMetrics, r: number, c: number): Box {
  return {
    left: `${c * m.pitch}%`,
    top: `${r * m.pitch}%`,
    width: `${m.cell}%`,
    height: `${m.cell}%`,
  };
}

/** Centre of a cell, as percentages — handy for pawns and floating effects. */
export function cellCentre(m: BoardMetrics, r: number, c: number): { x: number; y: number } {
  return { x: c * m.pitch + m.cell / 2, y: r * m.pitch + m.cell / 2 };
}

/** The visual footprint of a wall at intersection (r, c). */
export function wallBox(m: BoardMetrics, r: number, c: number, orientation: 0 | 1): Box {
  if (orientation === 0) {
    return {
      left: `${c * m.pitch}%`,
      top: `${r * m.pitch + m.cell}%`,
      width: `${2 * m.cell + m.gap}%`,
      height: `${m.gap}%`,
    };
  }
  return {
    left: `${c * m.pitch + m.cell}%`,
    top: `${r * m.pitch}%`,
    width: `${m.gap}%`,
    height: `${2 * m.cell + m.gap}%`,
  };
}

/**
 * The touch target for a wall slot. Deliberately fatter than the wall itself —
 * a 20 %-of-a-cell gap is only about 7 px on a phone, far below a comfortable
 * tap target, so we grow the hit area perpendicular to the wall and let the
 * visible bar stay slim inside it.
 */
export function slotBox(m: BoardMetrics, r: number, c: number, orientation: 0 | 1): Box {
  const grow = m.cell * SLOT_GROW;
  if (orientation === 0) {
    return {
      left: `${c * m.pitch}%`,
      top: `${r * m.pitch + m.cell - grow / 2}%`,
      width: `${2 * m.cell + m.gap}%`,
      height: `${m.gap + grow}%`,
    };
  }
  return {
    left: `${c * m.pitch + m.cell - grow / 2}%`,
    top: `${r * m.pitch}%`,
    width: `${m.gap + grow}%`,
    height: `${2 * m.cell + m.gap}%`,
  };
}

/** Map a pointer position inside the board to the nearest wall intersection. */
export function nearestSlot(
  m: BoardMetrics,
  xPct: number,
  yPct: number,
  orientation: 0 | 1,
): { r: number; c: number } | null {
  const max = m.size - 2;
  if (orientation === 0) {
    // Horizontal walls sit on a row boundary and span two columns.
    const r = Math.round(yPct / m.pitch) - 1;
    const c = Math.round(xPct / m.pitch - 0.5);
    if (r < 0 || c < 0 || r > max || c > max) return null;
    return { r, c };
  }
  const c = Math.round(xPct / m.pitch) - 1;
  const r = Math.round(yPct / m.pitch - 0.5);
  if (r < 0 || c < 0 || r > max || c > max) return null;
  return { r, c };
}

export function seatColorVar(seat: number): string {
  return `var(--p${seat})`;
}

export function seatDeepVar(seat: number): string {
  return `var(--p${seat}-deep)`;
}
