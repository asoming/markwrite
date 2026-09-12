import { describe, expect, it } from 'vitest';
import { ReadingSearchIndex, readingPlainText } from '../src/lib/readingSearch';
import { highlightReadingMatches } from '../src/lib/readingDom';

describe('reading search across virtual blocks', () => {
  it('counts all matches and wraps through blocks including literal regex characters', () => {
    const index = new ReadingSearchIndex([
      { text: '中文 [foo] and [FOO]', fromLine: 1 },
      { text: 'No match', fromLine: 3 },
      { text: '[foo] at the end', fromLine: 2000 },
    ]);
    expect(index.search('[foo]', -1)).toMatchObject({
      total: 3,
      index: 2,
      hit: { block: 2, line: 2000 },
    });
    expect(index.search('[foo]', 3)).toMatchObject({ index: 0, hit: { block: 0, from: 3 } });
    expect(index.search('[foo]', 0, true).total).toBe(2);
    expect(index.search('').total).toBe(0);
  });
  it('indexes actual HTML entities and excludes script and style content', () => {
    expect(
      readingPlainText('<p title="a > b">Caf&eacute; &amp; &#x4e2d;文</p><script>hidden</script>'),
    ).toBe('Café & 中文');
  });
  it('highlights a match spanning inline elements without damaging its link or click handler', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p><a href="note.md">hello <strong>world</strong></a> hello world</p>';
    const link = root.querySelector('a');
    highlightReadingMatches(root, 'hello world', 1);
    expect(root.querySelectorAll('mark.reading-match')).toHaveLength(3);
    expect(root.querySelectorAll('mark.active')).toHaveLength(1);
    expect(root.querySelector('a')).toBe(link);
    expect(root.textContent).toBe('hello world hello world');
    highlightReadingMatches(root, '', -1);
    expect(root.querySelector('mark')).toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('world');
  });
});
