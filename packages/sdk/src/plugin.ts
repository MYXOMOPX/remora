export type JsonSchema = Record<string, unknown>;

export interface TimeAxisDef {
  name: string;
  description: string;
  valueSchema: JsonSchema;
  example: unknown;
  encode(value: unknown): bigint;
  decode(n: bigint): unknown;
}

export interface RetentionRow {
  id: bigint;
  payload: unknown;
  retentionState: unknown;
  createdAt: Date;
}

export type RetentionAction =
  | { id: bigint; action: 'keep' }
  | { id: bigint; action: 'replace'; payload: unknown; retentionState: unknown }
  | { id: bigint; action: 'purge' };

export interface EvidenceSourceDef {
  name: string;
  description: string;
  payloadSchema: JsonSchema;
  ingest(payload: unknown): { payload: unknown; retentionState?: unknown };
  planRetention(rows: RetentionRow[], now: Date): RetentionAction[];
}

export interface PluginDef<C = unknown> {
  name: string;
  configSchema: JsonSchema;
  defaultConfig: C;
  setup(config: C): { timeAxes?: TimeAxisDef[]; evidenceSources?: EvidenceSourceDef[] };
}

export function definePlugin<C>(def: PluginDef<C>): PluginDef<C> {
  return def;
}
