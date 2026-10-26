import { describe, expect, it } from 'vitest';
import { clampLimit, escapeLike, wordPatterns } from '../src/sql/like.js';

describe('like helpers', () => {
  it('escapeLike escapes backslash, % and _', () => {
    expect(escapeLike('50%_x\\')).toBe('50\\%\\_x\\\\');
  });
  it('wordPatterns splits on whitespace', () => {
    expect(wordPatterns('  bob   ann ')).toEqual(['%bob%', '%ann%']);
    expect(wordPatterns('')).toEqual([]);
  });
  it('clampLimit defaults, caps and validates', () => {
    expect(clampLimit()).toBe(50);
    expect(clampLimit(1000)).toBe(200);
    expect(() => clampLimit(0)).toThrow(expect.objectContaining({ code: 'invalid_param' }));
    expect(() => clampLimit(1.5)).toThrow(expect.objectContaining({ code: 'invalid_param' }));
  });
});
