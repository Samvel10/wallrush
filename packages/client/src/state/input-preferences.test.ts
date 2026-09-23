import { strict as assert } from 'node:assert';
import test from 'node:test';
import { wantsMoveConfirmation } from './input-preferences.ts';

test('new and legacy touch profiles use one tap', () => {
  for (const saved of [null, undefined, {}, { confirmMoves: true }, { confirmMoves: false }]) {
    assert.equal(wantsMoveConfirmation(saved), false);
  }
});

test('explicit confirmation survives subsequent loads', () => {
  assert.equal(wantsMoveConfirmation({ inputVersion: 2, confirmMoves: true }), true);
  assert.equal(wantsMoveConfirmation({ inputVersion: 2, confirmMoves: false }), false);
  assert.equal(wantsMoveConfirmation({ inputVersion: 2, confirmMoves: 'true' }), false);
});
