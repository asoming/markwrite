/** A source-based location survives virtual unmounts and most edits before a paragraph. */
export type ReadingLocation = { line: number; block: number; offset: number; quote: string };
export type ReadingBookmark = ReadingLocation & { id: string; createdAt: number };
export type ReadingState = { location?: ReadingLocation; bookmarks: ReadingBookmark[] };
const PREFIX = 'markwrite.reading.v1:';

function location(value: unknown): ReadingLocation | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Partial<ReadingLocation>;
  if (!Number.isFinite(item.line) || item.line! < 1) return;
  return {
    line: Math.floor(item.line!),
    block: Number.isFinite(item.block) ? Math.max(0, Math.floor(item.block!)) : 0,
    offset: Number.isFinite(item.offset) ? Math.max(0, Math.min(1, item.offset!)) : 0,
    quote: typeof item.quote === 'string' ? item.quote.slice(0, 160) : '',
  };
}
export function readReadingState(key?: string): ReadingState {
  if (!key) return { bookmarks: [] };
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    return {
      location: location(value?.location),
      bookmarks: Array.isArray(value?.bookmarks)
        ? value.bookmarks.flatMap((item: ReadingBookmark) => {
            const point = location(item);
            return point && typeof item.id === 'string' && Number.isFinite(item.createdAt)
              ? [{ ...point, id: item.id, createdAt: item.createdAt }]
              : [];
          })
        : [],
    };
  } catch {
    return { bookmarks: [] };
  }
}
/** Keep the last independently saved bookmarks when a scroll-position update is written. */
export function saveReadingLocation(key: string, point: ReadingLocation) {
  const state = readReadingState(key);
  localStorage.setItem(PREFIX + key, JSON.stringify({ ...state, location: point }));
}
export function saveReadingBookmarks(key: string, bookmarks: ReadingBookmark[]) {
  const state = readReadingState(key);
  localStorage.setItem(PREFIX + key, JSON.stringify({ ...state, bookmarks }));
}

/** Prefix sums keep scrolling and measured-height updates logarithmic for large documents. */
export class ReadingHeights {
  readonly values: number[];
  private readonly tree: Float64Array;
  constructor(heights: readonly number[]) {
    this.values = heights.map((height) => Math.max(1, height));
    this.tree = new Float64Array(heights.length + 1);
    this.values.forEach((height, index) => this.add(index, height));
  }
  private add(index: number, delta: number) {
    for (let n = index + 1; n < this.tree.length; n += n & -n) this.tree[n] += delta;
  }
  update(index: number, height: number) {
    if (index < 0 || index >= this.values.length || !Number.isFinite(height)) return 0;
    const next = Math.max(1, height),
      delta = next - this.values[index];
    this.values[index] = next;
    this.add(index, delta);
    return delta;
  }
  before(index: number) {
    let sum = 0;
    for (let n = Math.min(this.values.length, Math.max(0, index)); n > 0; n -= n & -n)
      sum += this.tree[n];
    return sum;
  }
  get total() {
    return this.before(this.values.length);
  }
  at(offset: number) {
    if (!this.values.length) return 0;
    let index = 0,
      sum = 0,
      bit = 1;
    while (bit * 2 < this.tree.length) bit *= 2;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next] <= Math.max(0, offset)) {
        sum += this.tree[next];
        index = next;
      }
    }
    return Math.min(index, this.values.length - 1);
  }
}
