import { RemoraError } from '@remora/sdk';
import { compileCached } from './ajv.js';
import type { ValueType } from './dictionaries.js';

const isDate = compileCached({ type: 'string', format: 'date' });
const isDateTime = compileCached({ type: 'string', format: 'date-time' });

function valid(type: ValueType, value: unknown): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'text':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && (isDate(value) || isDateTime(value));
    case 'json':
      return value !== undefined;
  }
}

export function checkValue(type: ValueType, value: unknown, ctx: { property: string }): void {
  if (!valid(type, value)) {
    throw new RemoraError('value_type_mismatch', `value does not match value_type ${type}`, {
      property: ctx.property,
      valueType: type,
    });
  }
}
