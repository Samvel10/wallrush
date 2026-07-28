import { strict as assert } from 'node:assert';
import test from 'node:test';

import { hy } from './hy.ts';
import { ru } from './ru.ts';
import { en } from './en.ts';

/**
 * The type system already guarantees that Russian and English have every key
 * Armenian has — a missing one is a compile error. It cannot check what is
 * *inside* the strings, and that is where translations go wrong: a dropped
 * `{name}` renders as a sentence with a hole in it, and a stray one renders as
 * literal braces on screen.
 */

type Node = string | string[] | { [key: string]: Node };

function walk(node: Node, path: string, visit: (path: string, value: string) => void): void {
  if (typeof node === 'string') return visit(path, node);
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item as Node, `${path}[${i}]`, visit));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    walk(value as Node, path ? `${path}.${key}` : key, visit);
  }
}

function placeholders(value: string): string[] {
  return (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
}

function collect(dict: unknown): Map<string, string> {
  const out = new Map<string, string>();
  walk(dict as Node, '', (path, value) => out.set(path, value));
  return out;
}

const HY = collect(hy);
const RU = collect(ru);
const EN = collect(en);

test('every translation carries the same placeholders as the Armenian', () => {
  for (const [path, source] of HY) {
    const want = placeholders(source);
    for (const [name, dict] of [
      ['ru', RU],
      ['en', EN],
    ] as const) {
      const value = dict.get(path);
      assert.ok(value !== undefined, `${name} is missing ${path}`);
      assert.deepEqual(
        placeholders(value),
        want,
        `${name}.${path} should interpolate ${want.join(', ') || 'nothing'}`,
      );
    }
  }
});

test('nothing is left blank or still in Armenian by accident', () => {
  for (const [path, value] of HY) {
    assert.ok(value.trim().length > 0, `hy.${path} is empty`);
  }
  const armenian = /[԰-֏]/;
  for (const [name, dict] of [
    ['ru', RU],
    ['en', EN],
  ] as const) {
    for (const [path, value] of dict) {
      assert.ok(value.trim().length > 0, `${name}.${path} is empty`);
      // The one legitimate exception is the language switcher naming Armenian.
      if (path.startsWith('meta.')) continue;
      assert.ok(!armenian.test(value), `${name}.${path} still reads Armenian: ${value}`);
    }
  }
});

test('no string smuggles markdown that the UI will not render', () => {
  // These are plain text inside elements; asterisks and underscores show up
  // literally, which has already happened once.
  for (const [name, dict] of [
    ['hy', HY],
    ['ru', RU],
    ['en', EN],
  ] as const) {
    for (const [path, value] of dict) {
      assert.ok(!/\*\*/.test(value), `${name}.${path} contains ** and would show it`);
    }
  }
});

test('the three dictionaries describe the same set of strings', () => {
  assert.equal(RU.size, HY.size, 'Russian and Armenian should have the same shape');
  assert.equal(EN.size, HY.size, 'English and Armenian should have the same shape');
});
