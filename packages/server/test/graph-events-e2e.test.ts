import corePlugin from '@remora/core-plugin';
import { describe, expect, it } from 'vitest';
import { startRemora, type RemoraApp } from '../src/app.js';
import { addEvidence, applyRetention, neighbors, searchEvents } from '../src/index.js';
import type { Importer } from '../src/plugins/registry.js';
import { createTestDb } from './helpers/testDb.js';

const importer: Importer = async (spec) => {
  if (spec === '@remora/core-plugin') return corePlugin;
  throw new Error(`cannot import ${spec}`);
};

type Row = Record<string, unknown>;

describe('graph, events and evidence end to end (spec 10.1)', () => {
  it('exports the new services from the package index', () => {
    for (const f of [neighbors, addEvidence, applyRetention, searchEvents]) expect(typeof f).toBe('function');
  });

  it('one batch, neighbors, event search, evidence and purge', async () => {
    const { url, drop } = await createTestDb();
    let app: RemoraApp | undefined;
    try {
      app = await startRemora({ databaseUrl: url, importer });
      const applied = await app.apply({
        ops: [
          {
            op: 'add_evidence',
            source: 'chat_message',
            as: 'e1',
            payload: { text: 'Боб теперь Senior в Google', sender: 'me', raw: 'x' },
          },
          { op: 'create_entity', key: 'bob' },
          { op: 'create_entity', key: 'carl' },
          { op: 'create_entity', key: 'google' },
          { op: 'create_property_type', name: 'job_title', description: 'Job title.', value_type: 'text', single_valued: true },
          { op: 'create_property_type', name: 'height', description: 'Height.', value_type: 'number', single_valued: true },
          { op: 'create_relation_type', name: 'works_at', description: 'Employment.', directed: true },
          { op: 'create_relation_type', name: 'friend_of', description: 'Friendship.', directed: false },
          {
            op: 'replace_property',
            entity: 'bob',
            property: 'job_title',
            value: 'Senior',
            time: { axis: 'game_day', at: 292 },
            evidence: '$e1',
          },
          {
            op: 'add_relation',
            type: 'works_at',
            from: 'bob',
            to: 'google',
            time: { axis: 'game_day', from: 292 },
            evidence: '$e1',
          },
          { op: 'add_relation', type: 'friend_of', from: 'bob', to: 'carl' },
          { op: 'add_property', entity: 'carl', property: 'height', value: 186 },
          {
            op: 'add_event',
            summary: 'Видел Боба, он сделал сальто',
            keywords: ['Сальто'],
            time: { axis: 'game_day', at: 300 },
            entities: [{ entity: 'bob', role: 'actor' }],
            evidence: '$e1',
          },
        ],
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      const e1 = (applied.results[0] as { id: number }).id;

      const q = await app.query({
        ops: [
          {
            op: 'neighbors',
            entity: 'bob',
            depth: 1,
            include: ['height'],
            order_by: { property: 'height', dir: 'desc' },
            limit: 1,
          },
          { op: 'search_events', keywords: ['сальто'], when: { axis: 'game_day', at: 300 } },
          { op: 'get_evidence', id: e1 },
        ],
      });
      expect(q.ok).toBe(true);
      if (!q.ok) return;
      const [nb, ev, evid] = q.results as [{ rows: Row[] }, { rows: Row[] }, Row];
      expect(nb.rows).toHaveLength(1);
      expect(nb.rows[0]).toMatchObject({ entity: 'carl', properties: { height: [186] } });
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]!.evidence_id).toBe(e1);
      expect(evid.payload).toEqual({ text: 'Боб теперь Senior в Google', sender: 'me' });
      expect(evid.payload).not.toHaveProperty('raw');
      const eventId = ev.rows[0]!.id as number;

      expect(await app.purgeEvidence({ ids: [BigInt(e1)] })).toEqual({ purged: 1, skippedPinned: 0 });

      const after = await app.query({
        ops: [
          { op: 'relation_history', entity: 'bob', relation_types: ['works_at'] },
          { op: 'get_event', id: eventId },
          { op: 'get_evidence', id: e1 },
        ],
      });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const [rh, ge, gev] = after.results as [{ rows: Row[] }, Row, Row];
      expect(rh.rows).toHaveLength(1);
      expect(rh.rows[0]!.evidence_id).toBe(e1);
      expect(ge.evidence_id).toBe(e1);
      expect(gev.payload).toBeNull();
      expect(gev.purged_at).not.toBeNull();
    } finally {
      await app?.close();
      await drop();
    }
  });
});
