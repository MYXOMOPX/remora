import { describe, expect, it } from 'vitest';
import { RemoraError, definePlugin } from '../src/index.js';

describe('@remora/sdk', () => {
  it('RemoraError carries code, message and details and serializes', () => {
    const e = new RemoraError('unknown_entity', 'нет такой сущности', { key: 'bob' });
    expect(e).toBeInstanceOf(Error);
    expect(e.toJSON()).toEqual({ code: 'unknown_entity', message: 'нет такой сущности', details: { key: 'bob' } });
  });
  it('RemoraError.toJSON omits details when absent', () => {
    expect(new RemoraError('not_found', 'x').toJSON()).toEqual({ code: 'not_found', message: 'x' });
  });
  it('definePlugin returns the same definition object', () => {
    const def = { name: 'p', configSchema: {}, defaultConfig: {}, setup: () => ({}) };
    expect(definePlugin(def)).toBe(def);
  });
});
