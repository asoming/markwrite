import { expect, it } from 'vitest';
import { compareText, comparisonContext } from '../src/lib/textComparison';
it('aligns inserted and deleted lines with their original line numbers', () => {
  const result = compareText('title\nold\nend\n', 'title\nnew\nextra\nend\n');
  expect(result.hunks).toBe(1);
  expect(result.added).toBe(2);
  expect(result.removed).toBe(1);
  expect(result.rows[2]).toMatchObject({ right: 'extra\n', rightLine: 3, left: undefined });
  expect(result.rows.at(-1)).toMatchObject({ leftLine: 3, rightLine: 4 });
  expect(result.rows.map((r) => r.left || '').join('')).toBe('title\nold\nend\n');
  expect(result.rows.map((r) => r.right || '').join('')).toBe('title\nnew\nextra\nend\n');
});
it('highlights Chinese and emoji characters while retaining unchanged text', () => {
  const r = compareText('速度 10，正常😀\n', '速度 20，正常😀\n').rows[0];
  expect(
    r.leftParts
      ?.filter((p) => p.changed)
      .map((p) => p.text)
      .join(''),
  ).toBe('1');
  expect(
    r.rightParts
      ?.filter((p) => p.changed)
      .map((p) => p.text)
      .join(''),
  ).toBe('2');
  expect(r.rightParts?.map((p) => p.text).join('')).toBe(r.right);
});
it('preserves spaces, line endings and missing final newline', () => {
  for (const [a, b] of [
    ['a\r\n', 'a\n'],
    ['a\n', 'a'],
    ['  a\n', 'a\n'],
    ['', 'new'],
    ['old', ''],
  ]) {
    const r = compareText(a, b);
    expect(r.hunks).toBe(1);
    expect(r.rows.map((x) => x.left || '').join('')).toBe(a);
    expect(r.rows.map((x) => x.right || '').join('')).toBe(b);
  }
});
it('collapses only unchanged context and expands without losing rows', () => {
  const before = Array.from({ length: 30 }, (_, i) => `${i}\n`).join('');
  const r = compareText(before, before.replace('15\n', 'changed\n'));
  const visible = comparisonContext(r.rows, new Set());
  expect(visible.some((x) => 'from' in x)).toBe(true);
  expect(visible.filter((x) => 'row' in x && x.row.kind === 'changed')).toHaveLength(1);
  const expanded = new Set(visible.filter((x) => 'from' in x).map((x) => x.from));
  expect(comparisonContext(r.rows, expanded)).toHaveLength(r.rows.length);
});
it('reports identical files and refuses oversized comparisons explicitly', () => {
  expect(compareText('same', 'same').hunks).toBe(0);
  expect(compareText('', '').hunks).toBe(0);
  expect(compareText('x'.repeat(2_000_001), '').error).toBe('size');
  expect(compareText('\n'.repeat(12_000), '').error).toBe('size');
});
