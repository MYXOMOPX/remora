import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';
import { buildSource } from '../src/sources.js';
import type { SourceConfig } from '../src/sources.js';

const day = 86_400_000;
const now = new Date('2027-01-01T00:00:00Z');
const src = buildSource({
  name: 'tg',
  schema: { type: 'object' },
  keep: ['text', 'sender', 'attachments'],
  retention: [{ after: '30 days', drop: ['attachments'] }, { after: '365 days', drop: '*' }],
});
const row = (ageDays: number, stage: unknown, payload: unknown = { text: 'hi', attachments: [1] }) => ({
  id: 1n,
  payload,
  retentionState: stage === null ? null : { stage },
  createdAt: new Date(now.getTime() - ageDays * day),
});
const plan = (r: ReturnType<typeof row>) => src.planRetention([r], now)[0];

describe('core evidence sources', () => {
  it('ingest keeps only listed keys', () => {
    expect(src.ingest({ text: 'hi', sender: 'a', extra: 1 })).toEqual({
      payload: { text: 'hi', sender: 'a' },
      retentionState: { stage: 0 },
    });
  });
  it('ingest without keep returns payload unchanged', () => {
    const s = buildSource({ name: 'x', schema: { type: 'object' } });
    expect(s.ingest({ a: 1, b: 2 }).payload).toEqual({ a: 1, b: 2 });
    expect(s.description).toBe('Evidence source x.');
  });
  it('planRetention', () => {
    expect(plan(row(10, 0))).toEqual({ id: 1n, action: 'keep' });
    expect(plan(row(40, 0))).toEqual({
      id: 1n, action: 'replace', payload: { text: 'hi' }, retentionState: { stage: 1 },
    });
    expect(plan(row(40, 1))).toEqual({ id: 1n, action: 'keep' });
    expect(plan(row(400, 0)).action).toBe('purge');
    expect(plan(row(400, 1)).action).toBe('purge');
    expect(plan(row(40, null)).action).toBe('replace');
    expect(plan(row(40, 0, 'x'))).toEqual({ id: 1n, action: 'replace', payload: 'x', retentionState: { stage: 1 } });
  });
  it('rejects invalid configs', () => {
    const bad = (c: unknown) => () => buildSource(c as SourceConfig);
    const code = { code: 'invalid_config' };
    expect(bad({ name: 'a' })).toThrow(expect.objectContaining(code));
    expect(bad({ name: 'a', schema: {}, retention: [{ after: '30 weeks', drop: [] }] })).toThrow(expect.objectContaining(code));
    expect(bad({ name: 'a', schema: {}, retention: [{ after: '30 days', drop: [] }, { after: '10 days', drop: [] }] })).toThrow(expect.objectContaining(code));
    expect(bad({ name: 'a', schema: {}, retention: [{ after: '1 day', drop: 5 }] })).toThrow(expect.objectContaining(code));
  });
  it('plugin setup wires sources', () => {
    expect(plugin.setup(plugin.defaultConfig).evidenceSources!.map((s) => s.name)).toEqual(['chat_message']);
    expect(plugin.setup({ timeAxes: [] }).evidenceSources).toEqual([]);
  });
});
