import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  BOT_RATING,
  PROVISIONAL_GAMES,
  START_RATING,
  applyElo,
  expectedScore,
  kFactor,
  tierOf,
} from '../rating.js';

/**
 * Ratings are the one number players keep, and a mistake here is both
 * permanent and visible. These pin down the properties rather than the
 * arithmetic: symmetry, direction, and the boundaries the UI draws badges on.
 */

const SETTLED = PROVISIONAL_GAMES + 5;

test('an even match is an even expectation', () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
  // Whatever one side is expected to score, the other is expected to lose.
  for (const [a, b] of [
    [1200, 1400],
    [900, 2400],
    [1750, 1755],
  ]) {
    assert.ok(Math.abs(expectedScore(a, b) + expectedScore(b, a) - 1) < 1e-12);
  }
  // Four hundred points is the classic ten-to-one.
  assert.ok(Math.abs(expectedScore(1600, 1200) - 10 / 11) < 1e-9);
});

test('two settled equals trade the same points', () => {
  const winner = applyElo(1200, SETTLED, 1200, 1);
  const loser = applyElo(1200, SETTLED, 1200, 0);
  assert.equal(winner.delta, 16, 'half of K=32 on an even match');
  assert.equal(loser.delta, -16);
  assert.equal(winner.delta + loser.delta, 0, 'a settled game moves no net rating');
});

test('a newcomer against a regular is not zero-sum, and that is the design', () => {
  // The newcomer moves on K=60 and the regular on K=32, so the pair does not
  // balance: rating enters the pool. That is the price of letting people find
  // their level quickly, and it is worth stating outright rather than
  // discovering it later in a leaderboard that has quietly drifted upwards.
  const newcomer = applyElo(1200, 0, 1200, 1);
  const regular = applyElo(1200, SETTLED, 1200, 0);
  assert.equal(newcomer.delta, 30);
  assert.equal(regular.delta, -16);
  assert.ok(newcomer.delta + regular.delta > 0, 'the provisional phase adds rating');
});

test('a draw between equals changes nothing', () => {
  const a = applyElo(1500, SETTLED, 1500, 0.5);
  assert.equal(a.delta, 0);
  assert.equal(a.after, 1500);
});

test('beating someone stronger is worth more', () => {
  const overUnderdog = applyElo(1600, SETTLED, 1200, 1).delta;
  const overFavourite = applyElo(1200, SETTLED, 1600, 1).delta;
  assert.ok(overFavourite > overUnderdog, 'the upset pays better');
  assert.ok(overUnderdog > 0, 'a win never costs rating');
  // And losing to someone stronger costs less than losing to someone weaker.
  assert.ok(applyElo(1200, SETTLED, 1600, 0).delta > applyElo(1600, SETTLED, 1200, 0).delta);
});

test('a new account moves faster than a settled one', () => {
  assert.equal(kFactor(START_RATING, 0), 60);
  assert.equal(kFactor(START_RATING, PROVISIONAL_GAMES - 1), 60);
  assert.equal(kFactor(START_RATING, PROVISIONAL_GAMES), 32);
  // Strong players move slowest, so a bad night cannot undo a season.
  assert.equal(kFactor(2000, SETTLED), 20);
  assert.equal(kFactor(2400, SETTLED), 12);

  const fresh = applyElo(1200, 0, 1200, 1).delta;
  const settled = applyElo(1200, SETTLED, 1200, 1).delta;
  assert.ok(fresh > settled, 'the provisional phase finds your level quickly');
});

test('rating cannot fall through the floor', () => {
  const bottom = applyElo(100, 0, 2400, 0);
  assert.ok(bottom.after >= 100, 'nobody drops below the floor');
  assert.ok(bottom.delta <= 0);
  // The delta has to agree with the clamp, not with what it wanted to be.
  assert.equal(bottom.after, bottom.before + bottom.delta);
});

test('tiers change exactly where they say they do', () => {
  const boundaries: [number, string][] = [
    [1399, 'bronze'],
    [1400, 'silver'],
    [1599, 'silver'],
    [1600, 'gold'],
    [1800, 'platinum'],
    [2000, 'diamond'],
    [2200, 'master'],
    [2400, 'grandmaster'],
  ];
  for (const [rating, tier] of boundaries) {
    assert.equal(tierOf(rating), tier, `${rating} should be ${tier}`);
  }
  assert.equal(tierOf(START_RATING), 'bronze', 'everyone starts at the bottom');
});

test('the advertised bot ratings climb with the levels', () => {
  const order = ['novice', 'easy', 'medium', 'hard', 'expert', 'master'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      BOT_RATING[order[i]] > BOT_RATING[order[i - 1]],
      `${order[i]} should be rated above ${order[i - 1]}`,
    );
  }
});
