/**
 * Geometry tests.
 *
 * These run straight from TypeScript via Node's type stripping, because the
 * module is pure arithmetic with no DOM and no React — exactly the kind of code
 * where an off-by-one produces a board that looks almost right.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  GAP_RATIO,
  SLOT_THICKNESS_PCT,
  cellBox,
  cellCentre,
  metricsFor,
  nearestSlot,
  slotBox,
  wallBox,
} from './geometry.ts';

const pct = (v: string): number => Number(v.replace('%', ''));

test('cells and gaps tile the board exactly', () => {
  for (const size of [5, 7, 9, 11]) {
    const m = metricsFor(size);
    const last = cellBox(m, size - 1, size - 1);
    const right = pct(last.left) + pct(last.width);
    assert.ok(
      Math.abs(right - 100) < 1e-9,
      `size ${size}: board ends at ${right}% instead of 100%`,
    );
    assert.ok(Math.abs(m.gap - m.cell * GAP_RATIO) < 1e-9);
    assert.ok(Math.abs(m.pitch - (m.cell + m.gap)) < 1e-9);
  }
});

test('the first cell starts at the origin', () => {
  const m = metricsFor(9);
  const first = cellBox(m, 0, 0);
  assert.equal(pct(first.left), 0);
  assert.equal(pct(first.top), 0);
});

test('cell centres are where you would draw them', () => {
  const m = metricsFor(9);
  const c = cellCentre(m, 0, 0);
  assert.ok(Math.abs(c.x - m.cell / 2) < 1e-9);
  assert.ok(Math.abs(c.y - m.cell / 2) < 1e-9);
  const mid = cellCentre(m, 4, 4);
  assert.ok(Math.abs(mid.x - 50) < 0.001, `centre cell should sit at 50%, got ${mid.x}`);
  assert.ok(Math.abs(mid.y - 50) < 0.001);
});

test('a horizontal wall spans two cells and sits in the gap', () => {
  const m = metricsFor(9);
  const w = wallBox(m, 3, 4, 0);
  assert.ok(Math.abs(pct(w.width) - (2 * m.cell + m.gap)) < 1e-9, 'spans two cells plus the gap');
  assert.ok(Math.abs(pct(w.height) - m.gap) < 1e-9, 'is as thick as the gap');
  // It must start exactly where column 4 starts and end where column 5 ends.
  const c4 = cellBox(m, 3, 4);
  const c5 = cellBox(m, 3, 5);
  assert.ok(Math.abs(pct(w.left) - pct(c4.left)) < 1e-9);
  assert.ok(Math.abs(pct(w.left) + pct(w.width) - (pct(c5.left) + pct(c5.width))) < 1e-9);
  // Vertically it sits between rows 3 and 4.
  const r3 = cellBox(m, 3, 4);
  const r4 = cellBox(m, 4, 4);
  assert.ok(Math.abs(pct(w.top) - (pct(r3.top) + pct(r3.height))) < 1e-9);
  assert.ok(Math.abs(pct(w.top) + pct(w.height) - pct(r4.top)) < 1e-9);
});

test('a vertical wall is the horizontal one, transposed', () => {
  const m = metricsFor(9);
  const h = wallBox(m, 2, 6, 0);
  const v = wallBox(m, 2, 6, 1);
  assert.ok(Math.abs(pct(v.width) - pct(h.height)) < 1e-9);
  assert.ok(Math.abs(pct(v.height) - pct(h.width)) < 1e-9);
});

test('walls never leave the board', () => {
  for (const size of [5, 7, 9, 11]) {
    const m = metricsFor(size);
    for (let r = 0; r <= size - 2; r++) {
      for (let c = 0; c <= size - 2; c++) {
        for (const o of [0, 1] as const) {
          const w = wallBox(m, r, c, o);
          const right = pct(w.left) + pct(w.width);
          const bottom = pct(w.top) + pct(w.height);
          assert.ok(pct(w.left) >= -1e-9 && right <= 100 + 1e-9, `wall ${r},${c},${o} overflows`);
          assert.ok(pct(w.top) >= -1e-9 && bottom <= 100 + 1e-9, `wall ${r},${c},${o} overflows`);
        }
      }
    }
  }
});

test('slots are fatter than the wall they place but stay centred on it', () => {
  const m = metricsFor(9);
  for (const o of [0, 1] as const) {
    const wall = wallBox(m, 3, 3, o);
    const slot = slotBox(m, 3, 3, o);
    const wallCentre = {
      x: pct(wall.left) + pct(wall.width) / 2,
      y: pct(wall.top) + pct(wall.height) / 2,
    };
    const slotCentre = {
      x: pct(slot.left) + pct(slot.width) / 2,
      y: pct(slot.top) + pct(slot.height) / 2,
    };
    assert.ok(Math.abs(wallCentre.x - slotCentre.x) < 1e-9, 'slot must be centred on the wall');
    assert.ok(Math.abs(wallCentre.y - slotCentre.y) < 1e-9);
    const thin = o === 0 ? pct(slot.height) : pct(slot.width);
    const wallThin = o === 0 ? pct(wall.height) : pct(wall.width);
    assert.ok(thin > wallThin, 'the touch target must be bigger than the visible bar');
  }
});

test('the slot thickness ratio matches the geometry it is drawn against', () => {
  const m = metricsFor(9);
  const slot = slotBox(m, 0, 0, 0);
  // The visible bar is SLOT_THICKNESS_PCT of the slot box, and must equal the gap.
  const bar = (pct(slot.height) * SLOT_THICKNESS_PCT) / 100;
  assert.ok(
    Math.abs(bar - m.gap) < 1e-9,
    `bar is ${bar}% of the board but the gap is ${m.gap}%`,
  );
});

test('the slot ratio is the same for every board size', () => {
  for (const size of [5, 7, 9, 11]) {
    const m = metricsFor(size);
    const slot = slotBox(m, 0, 0, 1);
    const bar = (pct(slot.width) * SLOT_THICKNESS_PCT) / 100;
    assert.ok(Math.abs(bar - m.gap) < 1e-9, `size ${size} mismatch`);
  }
});

test('a pointer near an intersection resolves to that intersection', () => {
  const m = metricsFor(9);
  // The centre of the horizontal wall at (3,4) must map back to (3,4).
  const w = wallBox(m, 3, 4, 0);
  const x = pct(w.left) + pct(w.width) / 2;
  const y = pct(w.top) + pct(w.height) / 2;
  assert.deepEqual(nearestSlot(m, x, y, 0), { r: 3, c: 4 });

  const v = wallBox(m, 5, 1, 1);
  const vx = pct(v.left) + pct(v.width) / 2;
  const vy = pct(v.top) + pct(v.height) / 2;
  assert.deepEqual(nearestSlot(m, vx, vy, 1), { r: 5, c: 1 });
});

test('a pointer outside the intersection grid resolves to nothing', () => {
  const m = metricsFor(9);
  assert.equal(nearestSlot(m, 0, 0, 0), null, 'top-left corner has no horizontal slot');
  assert.equal(nearestSlot(m, 100, 100, 0), null);
  assert.equal(nearestSlot(m, 0, 0, 1), null);
  assert.equal(nearestSlot(m, -10, 50, 1), null);
});

test('every intersection is reachable by pointing at it', () => {
  const m = metricsFor(9);
  for (const o of [0, 1] as const) {
    for (let r = 0; r <= 7; r++) {
      for (let c = 0; c <= 7; c++) {
        const w = wallBox(m, r, c, o);
        const x = pct(w.left) + pct(w.width) / 2;
        const y = pct(w.top) + pct(w.height) / 2;
        assert.deepEqual(
          nearestSlot(m, x, y, o),
          { r, c },
          `pointing at the centre of ${r},${c},${o} should select it`,
        );
      }
    }
  }
});
