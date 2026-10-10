import { describe, expect, it } from 'vitest';
import { findLiteralMatches } from '../../src/renderer/modules/search.ts';

describe('Literal search uses offsets in the original document', () => {
  it('does not shift matches after Unicode case expansion', () => {
    const text = 'İXYZ 中文 👨‍👩‍👧‍👦 é XYZ';
    const matches = findLiteralMatches(text, 'xyz');
    expect(matches.map(match => text.slice(match.start, match.end))).toEqual(['XYZ', 'XYZ']);
    expect(matches[0]).toEqual({ start: 1, end: 4 });
  });
  it('treats backslashes and regular expression syntax as literal text', () => {
    const text = String.raw`\\ \\frac [x] $1 a.b (x) + * ?`;
    for (const query of [String.raw`\\`, '[x]', '$1', 'a.b', '(x)', '+', '*', '?']) {
      const matches = findLiteralMatches(text, query);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every(match => text.slice(match.start, match.end) === query)).toBe(true);
    }
  });
  it('retains whitespace, emoji and combining-character offsets', () => {
    expect(findLiteralMatches('a  b a  b', '  ')).toEqual([{ start: 1, end: 3 }, { start: 6, end: 8 }]);
    const text = '😀é\r\n😀é';
    expect(findLiteralMatches(text, '😀é').map(match => text.slice(match.start, match.end))).toEqual(['😀é', '😀é']);
    expect(findLiteralMatches(text, '')).toEqual([]);
  });
  it('finds nonoverlapping matches with original case', () => {
    expect(findLiteralMatches('AaAaA', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
});
