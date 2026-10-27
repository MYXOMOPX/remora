/** Every error code of the API; the list is also published in the contract. */
export const ERROR_CODES = [
  'unknown_entity',
  'unknown_type',
  'unknown_axis',
  'unknown_ref',
  'value_type_mismatch',
  'single_valued_conflict',
  'timeless_conflict',
  'invalid_time',
  'not_found',
  'name_taken',
  'invalid_payload',
  'unknown_source',
  'too_many_paths',
  'concurrent_update',
  'axis_unavailable',
  'source_unavailable',
  'invalid_name',
  'invalid_param',
  'invalid_plugin',
  'invalid_config',
  'internal',
  'timeout',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class RemoraError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RemoraError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
