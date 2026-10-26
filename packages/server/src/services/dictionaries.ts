import { RemoraError } from '@remora/sdk';
import { Pool } from 'pg';
import type { Queryable } from '../db/types.js';
import { wordPatterns } from '../sql/like.js';

export interface RelationType {
  id: number;
  name: string;
  description: string;
  directed: boolean;
}

export type ValueType = 'number' | 'text' | 'date' | 'bool' | 'json';

export interface PropertyType {
  id: number;
  name: string;
  description: string;
  valueType: ValueType;
  singleValued: boolean;
}

export interface TimeAxisInfo {
  name: string;
  description: string;
  valueSchema: unknown;
  example: unknown;
}

const VALUE_TYPES: readonly string[] = ['number', 'text', 'date', 'bool', 'json'];

/** Lowercase, whitespace to `_`, NFC first, drop everything except Unicode letters/marks/digits/`_`, collapse `_`, trim `_`. */
export function normalizeName(raw: string): string {
  const name = raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/gu, '_')
    .replace(/[^\p{L}\p{M}\p{N}_]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (name === '') {
    throw new RemoraError('invalid_name', 'type name must contain letters or digits', { name: raw });
  }
  return name;
}

/**
 * Runs `fn` in a transaction holding the type-name advisory lock.
 * For a Pool: checks out a client and wraps the work in BEGIN/COMMIT.
 * Otherwise `db` must be a client that is already inside a transaction
 * (the lock is transaction-scoped and is released when the caller ends it).
 */
async function withNameLock<T>(db: Queryable | Pool, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const locked = async (q: Queryable): Promise<T> => {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext('remora.type_names'))`);
    return fn(q);
  };
  if (!(db instanceof Pool)) return locked(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await locked(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}

async function assertNameFree(q: Queryable, name: string): Promise<void> {
  const r = await q.query<{ dictionary: string }>(
    `SELECT 'relation_type' AS dictionary FROM relation_type WHERE name = $1
     UNION ALL
     SELECT 'property_type' FROM property_type WHERE name = $1`,
    [name],
  );
  if (r.rows[0]) {
    throw new RemoraError('name_taken', `type name already taken: ${name}`, {
      name,
      dictionary: r.rows[0].dictionary,
    });
  }
}

function requireDescription(description: string): void {
  if (description.trim() === '') {
    throw new RemoraError('invalid_param', 'description must not be empty');
  }
}

interface RawRelation {
  id: number;
  name: string;
  description: string;
  directed: boolean;
}

interface RawProperty {
  id: number;
  name: string;
  description: string;
  value_type: ValueType;
  single_valued: boolean;
}

const toRelation = (r: RawRelation): RelationType => ({
  id: r.id,
  name: r.name,
  description: r.description,
  directed: r.directed,
});

const toProperty = (r: RawProperty): PropertyType => ({
  id: r.id,
  name: r.name,
  description: r.description,
  valueType: r.value_type,
  singleValued: r.single_valued,
});

export async function createRelationType(
  db: Queryable | Pool,
  args: { name: string; description: string; directed: boolean },
): Promise<RelationType> {
  const name = normalizeName(args.name);
  requireDescription(args.description);
  return withNameLock(db, async (q) => {
    await assertNameFree(q, name);
    const r = await q.query<RawRelation>(
      `INSERT INTO relation_type (name, description, directed) VALUES ($1, $2, $3)
       RETURNING id, name, description, directed`,
      [name, args.description, args.directed],
    );
    return toRelation(r.rows[0]!);
  });
}

export async function createPropertyType(
  db: Queryable | Pool,
  args: { name: string; description: string; valueType: ValueType; singleValued: boolean },
): Promise<PropertyType> {
  const name = normalizeName(args.name);
  requireDescription(args.description);
  if (!VALUE_TYPES.includes(args.valueType)) {
    throw new RemoraError('invalid_param', `invalid valueType: ${String(args.valueType)}`, {
      valueType: args.valueType,
    });
  }
  return withNameLock(db, async (q) => {
    await assertNameFree(q, name);
    const r = await q.query<RawProperty>(
      `INSERT INTO property_type (name, description, value_type, single_valued) VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, value_type, single_valued`,
      [name, args.description, args.valueType, args.singleValued],
    );
    return toProperty(r.rows[0]!);
  });
}

const RELATION_COLS = 'id, name, description, directed';
const PROPERTY_COLS = 'id, name, description, value_type, single_valued';

export async function listRelationTypes(db: Queryable): Promise<RelationType[]> {
  const r = await db.query<RawRelation>(`SELECT ${RELATION_COLS} FROM relation_type ORDER BY name`);
  return r.rows.map(toRelation);
}

export async function listPropertyTypes(db: Queryable): Promise<PropertyType[]> {
  const r = await db.query<RawProperty>(`SELECT ${PROPERTY_COLS} FROM property_type ORDER BY name`);
  return r.rows.map(toProperty);
}

function wordFilter(query: string): { where: string; params: string[] } {
  const patterns = wordPatterns(query);
  if (patterns.length === 0) return { where: 'true', params: [] };
  const where = patterns
    .map((_, i) => `(name ILIKE $${i + 1} OR description ILIKE $${i + 1})`)
    .join(' AND ');
  return { where, params: patterns };
}

export async function findRelationTypes(db: Queryable, query: string): Promise<RelationType[]> {
  const { where, params } = wordFilter(query);
  const r = await db.query<RawRelation>(
    `SELECT ${RELATION_COLS} FROM relation_type WHERE ${where} ORDER BY name`,
    params,
  );
  return r.rows.map(toRelation);
}

export async function findPropertyTypes(db: Queryable, query: string): Promise<PropertyType[]> {
  const { where, params } = wordFilter(query);
  const r = await db.query<RawProperty>(
    `SELECT ${PROPERTY_COLS} FROM property_type WHERE ${where} ORDER BY name`,
    params,
  );
  return r.rows.map(toProperty);
}

export async function listTimeAxes(db: Queryable): Promise<TimeAxisInfo[]> {
  const r = await db.query<{
    name: string;
    description: string;
    value_schema: unknown;
    example: unknown;
  }>('SELECT name, description, value_schema, example FROM time_axis ORDER BY id');
  return r.rows.map((x) => ({
    name: x.name,
    description: x.description,
    valueSchema: x.value_schema,
    example: x.example,
  }));
}
