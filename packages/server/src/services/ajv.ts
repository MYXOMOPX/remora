import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// Single Ajv instance for value/time validation (registry.ts keeps its own, config-checking one).
const addFormats = addFormatsModule.default;
export const ajv = new Ajv({ strict: false });
addFormats(ajv);

const cache = new WeakMap<object, ValidateFunction>();

export function compileCached(schema: object): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}
