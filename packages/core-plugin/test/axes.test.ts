import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';
import { buildAxis } from '../src/axes.js';

const story = buildAxis({ name: 'story', kind: 'packed', components: [
  { name: 'tome', max: 999 }, { name: 'chapter', max: 999 }, { name: 'scene', max: 999 }] });

describe('core axes', () => {
  it('packs components by radix max+1', () => {
    expect(story.encode({ tome: 2, chapter: 3, scene: 1 })).toBe(2_003_001n);
    expect(story.encode({ tome: 2 })).toBe(2_000_000n);
  });
  it('preserves order', () => {
    expect(story.encode({ tome: 2, chapter: 999, scene: 999 })).toBeLessThan(story.encode({ tome: 3 }));
  });
  it('rejects out-of-range components (no collision (2,1000,0) vs (3,0,0))', () => {
    expect(() => story.encode({ tome: 2, chapter: 1000 })).toThrow(expect.objectContaining({ code: 'invalid_time' }));
    for (const bad of [{ tome: -1 }, { tome: 1.5 }, { tome: '1' }, {}, null, 'x'])
      expect(() => story.encode(bad)).toThrow(expect.objectContaining({ code: 'invalid_time' }));
  });
  it('round-trips', () => {
    expect(story.decode(story.encode({ tome: 10, chapter: 5, scene: 0 }))).toEqual({ tome: 10, chapter: 5, scene: 0 });
  });
  it('datetime seconds', () => {
    const real = buildAxis({ name: 'real', kind: 'datetime', unit: 'seconds' });
    expect(real.encode('2026-10-01T00:00:00Z')).toBe(1_790_812_800n);
    expect(real.encode('2026-10-01T03:00:00+03:00')).toBe(1_790_812_800n);
    expect(real.decode(1_790_812_800n)).toBe('2026-10-01T00:00:00.000Z');
    expect(() => real.encode('2026-10-01')).toThrow(expect.objectContaining({ code: 'invalid_time' }));
  });
  it('integer axis', () => {
    const day = buildAxis({ name: 'game_day', kind: 'integer' });
    expect(day.encode(292)).toBe(292n);
    expect(() => day.encode(1.5)).toThrow(expect.objectContaining({ code: 'invalid_time' }));
  });
  it('packed with huge radix stays exact beyond 2^53', () => {
    const big = buildAxis({ name: 'big', kind: 'packed', components: [{ name: 'a', max: 999_999_999 }, { name: 'b', max: 999_999_999 }] });
    expect(big.decode(big.encode({ a: 9_007_199, b: 254_740_993 }))).toEqual({ a: 9_007_199, b: 254_740_993 });
  });
  it('default plugin config builds story/game_day/real with non-empty description, schema and example', () => {
    const axes = plugin.setup(plugin.defaultConfig).timeAxes!;
    expect(axes.map(a => a.name)).toEqual(['game_day', 'real', 'story']);
    for (const a of axes) { expect(a.description.length).toBeGreaterThan(10); expect(a.example).toBeDefined(); }
    expect(axes[2].example).toEqual({ tome: 10, chapter: 5 });
  });
  it('derives fallback examples when none configured', () => {
    expect(buildAxis({ name: 'a', kind: 'integer' }).example).toBe(1);
    expect(buildAxis({ name: 'a', kind: 'datetime', unit: 'seconds' }).example).toBe('2026-01-01T00:00:00Z');
    expect(story.example).toEqual({ tome: 1, chapter: 1 });
    expect(buildAxis({ name: 'a', kind: 'packed', components: [{ name: 'x', max: 9 }] }).example).toEqual({ x: 1 });
  });
  it('packed valueSchema requires the first component and description states the rule', () => {
    expect(story.valueSchema).toMatchObject({ type: 'object', required: ['tome'] });
    expect(story.description).toContain('старший компонент первым');
  });
});
