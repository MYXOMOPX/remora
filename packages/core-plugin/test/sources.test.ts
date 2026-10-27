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
  it('rejects equal, zero and unknown-key stage configs', () => {
    const bad = (retention: unknown) => () => buildSource({ name: 'a', schema: {}, retention } as SourceConfig);
    const code = { code: 'invalid_config' };
    expect(bad([{ after: '30 days', drop: [] }, { after: '30 days', drop: [] }])).toThrow(expect.objectContaining(code));
    expect(bad([{ after: '1 day', drop: [] }, { after: '24 hours', drop: [] }])).toThrow(expect.objectContaining(code));
    expect(bad([{ after: '0 days', drop: [] }])).toThrow(expect.objectContaining(code));
    expect(bad([{ after: '1 day', drop: [], extra: 1 }])).toThrow(expect.objectContaining(code));
    expect(() => buildSource({ name: 'a', schema: {}, typo: 1 } as unknown as SourceConfig)).toThrow(
      expect.objectContaining(code),
    );
  });
  it('error messages are English', () => {
    expect(() => buildSource({ name: 'a' } as SourceConfig)).toThrow(/^Source "a": schema must be an object$/);
  });
  it('keep uses own properties only and cannot pollute prototypes', () => {
    const s = buildSource({ name: 'p', schema: {}, keep: ['__proto__', 'constructor', 'text'] });
    expect(JSON.stringify(s.ingest({ text: 't' }).payload)).toBe('{"text":"t"}');
    const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":"c","text":"t"}');
    const out = s.ingest(evil).payload as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.polluted).toBeUndefined();
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'text']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('treats an invalid stored stage as stage 0', () => {
    for (const stage of [-1, 1.5, '1', null, Number.NaN]) {
      expect(plan(row(40, stage))).toEqual({
        id: 1n, action: 'replace', payload: { text: 'hi' }, retentionState: { stage: 1 },
      });
    }
  });
  it('does not mutate its input', () => {
    const payload = Object.freeze({ text: 'hi', attachments: Object.freeze([1]) });
    const r = Object.freeze({ ...row(40, 0, payload), retentionState: Object.freeze({ stage: 0 }) });
    expect(() => src.planRetention([r], now)).not.toThrow();
    expect(() => src.ingest(payload)).not.toThrow();
    expect(payload).toEqual({ text: 'hi', attachments: [1] });
  });
  it('unions the drops of several pending stages', () => {
    const s = buildSource({
      name: 'm',
      schema: {},
      retention: [
        { after: '1 day', drop: ['a'] },
        { after: '2 days', drop: ['b'] },
        { after: '3 days', drop: ['c'] },
      ],
    });
    const r = { id: 1n, payload: { a: 1, b: 2, c: 3, d: 4 }, retentionState: { stage: 0 }, createdAt: new Date(now.getTime() - 2.5 * day) };
    expect(s.planRetention([r], now)[0]).toEqual({
      id: 1n, action: 'replace', payload: { c: 3, d: 4 }, retentionState: { stage: 2 },
    });
  });
  it('default chat_message source has an English description', () => {
    const chat = plugin.defaultConfig.evidenceSources!.find((s) => s.name === 'chat_message')!;
    expect(chat.description).toMatch(/^Chat message/);
  });
  it('plugin setup rejects duplicate source and axis names', () => {
    const s = { name: 'dup', schema: {} };
    expect(() => plugin.setup({ timeAxes: [], evidenceSources: [s, s] })).toThrow(
      expect.objectContaining({ code: 'invalid_config' }),
    );
    const ax = { name: 'd', kind: 'integer' as const };
    expect(() => plugin.setup({ timeAxes: [ax, ax] })).toThrow(expect.objectContaining({ code: 'invalid_config' }));
  });
  it('plugin setup wires sources', () => {
    expect(plugin.setup(plugin.defaultConfig).evidenceSources!.map((s) => s.name)).toEqual(['chat_message']);
    expect(plugin.setup({ timeAxes: [] }).evidenceSources).toEqual([]);
  });
});
