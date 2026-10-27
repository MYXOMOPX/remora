import { describe, expect, it } from 'vitest';
import { RemoraError } from '@remora/sdk';
import { encodeValue, formatEventTime, formatTime, parseEventTimes, parseMoment, parseSpans, parseWhen } from '../src/services/time.js';
import { bigAxis, fakeRegistry, intAxis } from './helpers/axes.js';

const reg = fakeRegistry([
  { id: 1, def: intAxis('game_day') },
  { id: 2, def: bigAxis('big') },
]);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RemoraError) return e.code;
    throw e;
  }
  return 'no error';
}

describe('parseSpans', () => {
  it('undefined -> []', () => expect(parseSpans(reg, undefined)).toEqual([]));
  it('single object', () => {
    const s = parseSpans(reg, { axis: 'game_day', from: 1, to: 5 });
    expect(s).toHaveLength(1);
    expect(s[0]!.lo).toBe(1n);
    expect(s[0]!.hi).toBe(5n);
    expect(s[0]!.axis.id).toBe(1);
  });
  it('array of two', () => {
    const s = parseSpans(reg, [{ axis: 'game_day', from: 1 }, { axis: 'big', to: { v: '7' } }]);
    expect(s.map((x) => x.axis.name)).toEqual(['game_day', 'big']);
    expect(s[1]!.hi).toBe(7n);
  });
  it('empty array', () => expect(codeOf(() => parseSpans(reg, []))).toBe('invalid_param'));
  it('null', () => expect(codeOf(() => parseSpans(reg, null))).toBe('invalid_param'));
  it('no bounds', () => {
    const s = parseSpans(reg, { axis: 'game_day' });
    expect(s[0]!.lo === null && s[0]!.hi === null).toBe(true);
  });
  it('from == to', () => expect(codeOf(() => parseSpans(reg, { axis: 'game_day', from: 5, to: 5 }))).toBe('invalid_time'));
  it('schema violation', () => expect(codeOf(() => parseSpans(reg, { axis: 'game_day', from: -1 }))).toBe('invalid_time'));
  it('wrong type', () => expect(codeOf(() => parseSpans(reg, { axis: 'game_day', from: 'x' }))).toBe('invalid_time'));
  it('unknown axis', () => expect(codeOf(() => parseSpans(reg, { axis: 'nope' }))).toBe('unknown_axis'));
  it('duplicate axis', () =>
    expect(codeOf(() => parseSpans(reg, [{ axis: 'game_day' }, { axis: 'game_day' }]))).toBe('invalid_param'));
  it('missing axis', () => expect(codeOf(() => parseSpans(reg, { from: 1 }))).toBe('invalid_param'));
  it('non-object', () => expect(codeOf(() => parseSpans(reg, 5))).toBe('invalid_param'));
});

describe('parseMoment', () => {
  it('parses', () => expect(parseMoment(reg, { axis: 'game_day', at: 292 }).at).toBe(292n));
  it('missing at', () => expect(codeOf(() => parseMoment(reg, { axis: 'game_day' }))).toBe('invalid_param'));
  it('undefined', () => expect(codeOf(() => parseMoment(reg, undefined))).toBe('invalid_param'));
});

describe('parseWhen', () => {
  it('undefined', () => expect(parseWhen(reg, undefined)).toBeUndefined());
  it('at', () => {
    const w = parseWhen(reg, { axis: 'game_day', at: 3 })!;
    expect('at' in w && w.at).toBe(3n);
  });
  it('during', () => {
    const w = parseWhen(reg, { axis: 'game_day', during: [290, 300] })!;
    expect('from' in w && w.from).toBe(290n);
    expect('to' in w && w.to).toBe(300n);
  });
  it('empty during', () => expect(codeOf(() => parseWhen(reg, { axis: 'game_day', during: [300, 300] }))).toBe('invalid_time'));
  it('bad during length', () => expect(codeOf(() => parseWhen(reg, { axis: 'game_day', during: [1] }))).toBe('invalid_param'));
  it('at and during', () =>
    expect(codeOf(() => parseWhen(reg, { axis: 'game_day', at: 1, during: [1, 2] }))).toBe('invalid_param'));
  it('neither', () => expect(codeOf(() => parseWhen(reg, { axis: 'game_day' }))).toBe('invalid_param'));
  it('at with from', () => expect(codeOf(() => parseWhen(reg, { axis: 'game_day', at: 1, from: 1 }))).toBe('invalid_param'));
});

describe('encodeValue / formatTime', () => {
  const big = reg.getAxis('big');
  it('out of int8', () =>
    expect(codeOf(() => encodeValue(big, { v: '9223372036854775808' }))).toBe('invalid_time'));
  it('max int8 ok', () => expect(encodeValue(big, { v: '9223372036854775807' })).toBe(9223372036854775807n));
  it('throwing encode -> invalid_time', () => {
    const def = { ...intAxis('x'), encode: () => { throw new Error('boom'); } };
    expect(codeOf(() => encodeValue({ id: 9, name: 'x', def }, 1))).toBe('invalid_time');
  });
  it('non-bigint result -> invalid_time', () => {
    const def = { ...intAxis('x'), encode: () => 5 as unknown as bigint };
    expect(codeOf(() => encodeValue({ id: 9, name: 'x', def }, 1))).toBe('invalid_time');
  });
  it('RemoraError passes through', () => {
    const def = { ...intAxis('x'), encode: () => { throw new RemoraError('unknown_axis', 'z'); } };
    expect(codeOf(() => encodeValue({ id: 9, name: 'x', def }, 1))).toBe('unknown_axis');
  });
  it('formats beyond 2^53 and omits absent bound', () => {
    const out = formatTime(reg, 2, '9007199254740993', null)!;
    expect(out).toEqual({ axis: 'big', from: { v: '9007199254740993' } });
    expect('to' in out).toBe(false);
  });
  it('null axis', () => expect(formatTime(reg, null, null, null)).toBeNull());
});

describe('parseEventTimes', () => {
  it('instant at', () => {
    const s = parseEventTimes(reg, { axis: 'game_day', at: 300 });
    expect(s).toHaveLength(1);
    expect([s[0]!.lo, s[0]!.hi, s[0]!.instant]).toEqual([300n, 301n, true]);
  });
  it('span from/to', () => {
    const s = parseEventTimes(reg, { axis: 'game_day', from: 299, to: 301 });
    expect([s[0]!.lo, s[0]!.hi, s[0]!.instant]).toEqual([299n, 301n, false]);
  });
  it('open span', () => {
    const s = parseEventTimes(reg, { axis: 'game_day' });
    expect([s[0]!.lo, s[0]!.hi, s[0]!.instant]).toEqual([null, null, false]);
  });
  it('two axes in an array', () => {
    const s = parseEventTimes(reg, [{ axis: 'game_day', at: 1 }, { axis: 'big', from: { v: '2' } }]);
    expect(s.map((x) => x.axis.name)).toEqual(['game_day', 'big']);
  });
  it('[] / undefined / duplicate axis / at with from -> invalid_param', () => {
    expect(codeOf(() => parseEventTimes(reg, []))).toBe('invalid_param');
    expect(codeOf(() => parseEventTimes(reg, undefined))).toBe('invalid_param');
    expect(codeOf(() => parseEventTimes(reg, [{ axis: 'game_day' }, { axis: 'game_day', at: 1 }]))).toBe(
      'invalid_param',
    );
    expect(codeOf(() => parseEventTimes(reg, { axis: 'game_day', at: 1, from: 0 }))).toBe('invalid_param');
  });
  it('from == to -> invalid_time', () =>
    expect(codeOf(() => parseEventTimes(reg, { axis: 'game_day', from: 5, to: 5 }))).toBe('invalid_time'));
  it('at without room for at+1 -> invalid_time', () =>
    expect(codeOf(() => parseEventTimes(reg, { axis: 'big', at: { v: '9223372036854775807' } }))).toBe(
      'invalid_time',
    ));
});

describe('formatEventTime', () => {
  it('instant', () => expect(formatEventTime(reg, 1, '300', '301', true)).toEqual({ axis: 'game_day', at: 300 }));
  it('open span', () => {
    const out = formatEventTime(reg, 1, '299', null, false);
    expect(out).toEqual({ axis: 'game_day', from: 299 });
    expect('to' in out).toBe(false);
  });
});
