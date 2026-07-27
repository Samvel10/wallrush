/**
 * WallRush — Elo rating.
 *
 * A conventional Elo implementation with a provisional phase: new accounts move
 * fast for their first games so they find their level quickly, then settle into
 * a slower K-factor. Strong players (2400+) move slowest of all.
 */

export const START_RATING = 1200;
export const PROVISIONAL_GAMES = 15;

export function kFactor(rating: number, gamesPlayed: number): number {
  if (gamesPlayed < PROVISIONAL_GAMES) return 60;
  if (rating >= 2400) return 12;
  if (rating >= 2000) return 20;
  return 32;
}

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export interface RatingChange {
  before: number;
  after: number;
  delta: number;
}

/**
 * @param score 1 = win, 0.5 = draw, 0 = loss (from A's point of view).
 */
export function applyElo(
  ratingA: number,
  gamesA: number,
  ratingB: number,
  score: number,
): RatingChange {
  const k = kFactor(ratingA, gamesA);
  const expected = expectedScore(ratingA, ratingB);
  const after = Math.round(ratingA + k * (score - expected));
  const clamped = Math.max(100, after);
  return { before: ratingA, after: clamped, delta: clamped - ratingA };
}

/** Human-readable tier used for badges in the UI. */
export type RatingTier =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'master'
  | 'grandmaster';

export function tierOf(rating: number): RatingTier {
  if (rating >= 2400) return 'grandmaster';
  if (rating >= 2200) return 'master';
  if (rating >= 2000) return 'diamond';
  if (rating >= 1800) return 'platinum';
  if (rating >= 1600) return 'gold';
  if (rating >= 1400) return 'silver';
  return 'bronze';
}

/**
 * Roughly where each bot level plays, shown in the UI as an approximation.
 *
 * These are anchored on measured head-to-head results between the levels, not
 * on wishful thinking: the gap between `hard`, `expert` and `master` is real
 * but modest, because at that strength the first-move advantage dominates a
 * single game. Deliberately conservative — a bot that plays above its badge is
 * a nicer surprise than one that plays below it.
 */
export const BOT_RATING: Record<string, number> = {
  novice: 650,
  easy: 950,
  medium: 1300,
  hard: 1550,
  expert: 1750,
  master: 1950,
};
