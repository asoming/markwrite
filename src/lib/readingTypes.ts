import type { ReadingLocation } from './readingState';

export type ReadingBlock = {
  index: number;
  fromLine: number;
  toLine: number;
  excerpt: string;
  characters: number;
  estimatedHeight: number;
  anchors: string[];
};
export type ReadingChunk = { index: number; html: string; source: string };
export type ReadingHit = { block: number; from: number; to: number; line: number };
export type ReadingSearch = {
  query: string;
  total: number;
  index: number;
  hit?: ReadingHit;
  /** Number of preceding matches per block, used to mark the active visible occurrence. */
  counts: number[];
};
export interface ReaderHandle {
  selectAll(): void;
  openSearch(query?: string): void;
  closeSearch(): void;
  findNext(direction?: 1 | -1): void;
  jumpToLine(line: number): void;
  jumpToAnchor(id: string): void;
  getLocation(): ReadingLocation | null;
  restoreLocation(location: ReadingLocation): void;
  toggleBookmark(): void;
  openBookmarks(): void;
}
