import { beforeEach, describe, expect, it } from 'vitest';
import {
  ReadingHeights,
  readReadingState,
  saveReadingBookmarks,
  saveReadingLocation,
} from '../src/lib/readingState';

beforeEach(() => localStorage.clear());
describe('reading positions and bookmarks', () => {
  it('stores each original file independently and preserves bookmarks while scrolling', () => {
    const point = { line: 24, block: 3, offset: 0.25, quote: '中文段落' };
    saveReadingBookmarks('/文档/a.md', [{ ...point, id: 'one', createdAt: 1 }]);
    saveReadingLocation('/文档/a.md', { ...point, line: 80 });
    saveReadingLocation('/other/a.md', { ...point, line: 4 });
    expect(readReadingState('/文档/a.md').location?.line).toBe(80);
    expect(readReadingState('/文档/a.md').bookmarks[0].line).toBe(24);
    expect(readReadingState('/other/a.md').location?.line).toBe(4);
  });
  it('ignores corrupted records and clamps restored positions', () => {
    localStorage.setItem(
      'markwrite.reading.v1:file',
      JSON.stringify({
        location: { line: 3, offset: 90, quote: 'a' },
        bookmarks: [null, { line: -1 }],
      }),
    );
    expect(readReadingState('file')).toEqual({
      location: { line: 3, block: 0, offset: 1, quote: 'a' },
      bookmarks: [],
    });
    localStorage.setItem('markwrite.reading.v1:file', 'broken');
    expect(readReadingState('file')).toEqual({ bookmarks: [] });
  });
});
describe('virtual reading height index', () => {
  it('keeps boundary lookup correct after blocks above and below the viewport change height', () => {
    const heights = new ReadingHeights([100, 200, 50, 80]);
    expect(heights.at(0)).toBe(0);
    expect(heights.at(100)).toBe(1);
    expect(heights.at(300)).toBe(2);
    expect(heights.update(0, 180)).toBe(80);
    expect(heights.before(2)).toBe(380);
    expect(heights.at(379)).toBe(1);
    heights.update(3, 120);
    expect(heights.total).toBe(550);
    expect(heights.at(10000)).toBe(3);
  });
});
