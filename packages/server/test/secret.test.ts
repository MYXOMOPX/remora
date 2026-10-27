import { describe, expect, it } from 'vitest';
import { generateSecret, isValidSecret, secretMatches } from '../src/http/secret.js';

describe('secret', () => {
  it('generateSecret yields 43 url-safe chars and differs per call', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isValidSecret(a)).toBe(true);
  });

  it('isValidSecret rejects short, odd-character and empty values', () => {
    expect(isValidSecret('a'.repeat(43))).toBe(true);
    expect(isValidSecret('a'.repeat(60))).toBe(true);
    expect(isValidSecret('a'.repeat(42))).toBe(false);
    expect(isValidSecret('a'.repeat(42) + '+')).toBe(false);
    expect(isValidSecret('a'.repeat(42) + '/')).toBe(false);
    expect(isValidSecret('a'.repeat(42) + '=')).toBe(false);
    expect(isValidSecret('')).toBe(false);
  });

  it('secretMatches compares exactly, including different lengths', () => {
    const s = generateSecret();
    expect(secretMatches(s, s)).toBe(true);
    expect(secretMatches(s + 'x', s)).toBe(false);
    expect(secretMatches(s.slice(1), s)).toBe(false);
    expect(secretMatches(s.toUpperCase(), s)).toBe(false);
    expect(secretMatches('', s)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });
});
