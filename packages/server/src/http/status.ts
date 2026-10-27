import type { ErrorCode } from '@remora/sdk';

/** R31: HTTP status for an `ok:false` envelope. */
export function statusFor(code: ErrorCode): number {
  switch (code) {
    case 'invalid_param':
    case 'invalid_time':
    case 'invalid_name':
    case 'invalid_payload':
    case 'value_type_mismatch':
    case 'unknown_ref':
    case 'invalid_config':
    case 'invalid_plugin':
      return 400;
    case 'not_found':
    case 'unknown_entity':
    case 'unknown_type':
    case 'unknown_axis':
    case 'unknown_source':
      return 404;
    case 'single_valued_conflict':
    case 'timeless_conflict':
    case 'name_taken':
    case 'concurrent_update':
      return 409;
    case 'too_many_paths':
      return 422;
    case 'axis_unavailable':
    case 'source_unavailable':
      return 503;
    case 'timeout':
      return 504;
    case 'internal':
      return 500;
  }
}
