import corePlugin from '@remora/core-plugin';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

const DAY = 86_400_000;

const tg = {
  name: 'tg',
  schema: { type: 'object' },
  keep: ['text', 'attachments'],
  retention: [
    { after: '30 days', drop: ['attachments'] },
    { after: '365 days', drop: '*' },
  ],
};

describe('evidence retention end to end (startRemora + core plugin)', () => {
  it('ingest keep-filter, staged trimming, purge and pinning', async () => {
    const { url, drop } = await createTestDb();
    let app: RemoraApp | undefined;
    try {
      app = await startRemora({ databaseUrl: url, importer });
      await app.close();
      app = undefined; // so the finally block never closes it a second time
      const pool = new (await import('pg')).default.Pool({ connectionString: url });
      await pool.query(`UPDATE plugin SET config = jsonb_set(config, '{evidenceSources}', $1::jsonb)`, [
        JSON.stringify([tg]),
      ]);
      await pool.end();
      app = await startRemora({ databaseUrl: url, importer });

      const add = async (): Promise<number> => {
        const r = await app!.apply({
          ops: [{ op: 'add_evidence', source: 'tg', payload: { text: 'hi', attachments: ['a.png'], noise: 1 } }],
        });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return (r.results[0] as { id: number }).id;
      };
      const get = async (id: number): Promise<{ payload: unknown; purged_at: string | null }> => {
        const r = await app!.query({ ops: [{ op: 'get_evidence', id }] });
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        return r.results[0] as { payload: unknown; purged_at: string | null };
      };

      const id = await add();
      const pinned = await add();
      await app.pinEvidence(BigInt(pinned));
      expect((await get(id)).payload).toEqual({ text: 'hi', attachments: ['a.png'] });

      await app.applyRetention({ now: new Date(Date.now() + 40 * DAY) });
      expect((await get(id)).payload).toEqual({ text: 'hi' });

      await app.applyRetention({ now: new Date(Date.now() + 400 * DAY) });
      const gone = await get(id);
      expect(gone.payload).toBeNull();
      expect(gone.purged_at).not.toBeNull();

      const kept = await get(pinned);
      expect(kept.payload).toEqual({ text: 'hi', attachments: ['a.png'] });
      expect(kept.purged_at).toBeNull();

      expect(await app.purgeEvidence({ ids: [BigInt(pinned)] })).toEqual({ purged: 0, skippedPinned: 1 });
      await app.unpinEvidence(BigInt(pinned));
      expect(await app.purgeEvidence({ ids: [BigInt(pinned)] })).toEqual({ purged: 1, skippedPinned: 0 });
    } finally {
      await app?.close();
      await drop();
    }
  });
});
