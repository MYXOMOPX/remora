import { describe, expect, it } from 'vitest';
import { RemoraError } from '@remora/sdk';
import { checkValue } from '../src/services/values.js';
import type { ValueType } from '../src/services/dictionaries.js';

const ok: Array<[ValueType, unknown]> = [
  ['number', 0], ['number', -1.5], ['text', ''], ['text', 'x'],
  ['date', '2026-10-26'], ['date', '2026-10-26T10:00:00Z'],
  ['bool', false], ['bool', true],
  ['json', null], ['json', { a: 1 }], ['json', [1]],
];
const bad: Array<[ValueType, unknown]> = [
  ['number', '1'], ['number', NaN], ['number', Infinity],
  ['text', null], ['text', 5],
  ['date', '26.10.2026'], ['date', '2026-13-40'], ['date', '2026-10-26T10:00:00'], ['date', 20261026],
  ['bool', 'true'], ['bool', 0],
  ['json', undefined],
];

describe('checkValue', () => {
  it.each(ok)('%s accepts %j', (t, v) => {
    expect(() => checkValue(t, v, { property: 'p' })).not.toThrow();
  });
  it.each(bad)('%s rejects %s', (t, v) => {
    try {
      checkValue(t, v, { property: 'p' });
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoraError);
      expect((e as RemoraError).code).toBe('value_type_mismatch');
      expect((e as RemoraError).details).toEqual({ property: 'p', valueType: t });
    }
  });
});
