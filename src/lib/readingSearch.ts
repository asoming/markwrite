import { decodeHTML } from 'entities';
import type { ReadingSearch } from './readingTypes';

export function readingPattern(query: string, caseSensitive = false) {
  return query
    ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
    : null;
}

/** HTML is rendered by our Markdown parser; this is a text index, never an HTML sanitizer. */
export function readingPlainText(html: string) {
  return decodeHTML(
    html
      .replace(/<thead\s+data-reading-repeat="true"[^>]*>[\s\S]*?<\/thead>/gi, '')
      .replace(/<(script|style|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<!--[^]*?-->/g, '')
      .replace(/<\/?[a-z][a-z\d-]*\b(?:[^<>\"']|\"[^\"]*\"|'[^']*')*>/gi, ''),
  );
}

/** Count every hit without retaining one object per occurrence in very repetitive files. */
export class ReadingSearchIndex {
  private previous = '';
  private counts: number[] = [];
  private total = 0;
  constructor(private blocks: readonly { text: string; fromLine: number }[]) {}
  search(query: string, requestedIndex = 0, caseSensitive = false): ReadingSearch {
    const pattern = readingPattern(query, caseSensitive);
    const key = JSON.stringify([query, caseSensitive]);
    if (key !== this.previous) {
      this.previous = key;
      this.total = 0;
      this.counts = this.blocks.map((block) => {
        let count = 0;
        if (pattern) for (const _match of block.text.matchAll(pattern)) count++;
        this.total += count;
        return count;
      });
    }
    const result: ReadingSearch = {
      query,
      total: this.total,
      index: this.total ? ((requestedIndex % this.total) + this.total) % this.total : -1,
      counts: this.counts,
    };
    if (!pattern || !this.total) return result;
    let within = result.index;
    for (let block = 0; block < this.blocks.length; block++) {
      if (within >= this.counts[block]) {
        within -= this.counts[block];
        continue;
      }
      for (const match of this.blocks[block].text.matchAll(pattern)) {
        if (within-- > 0) continue;
        result.hit = {
          block,
          from: match.index!,
          to: match.index! + match[0].length,
          line: this.blocks[block].fromLine,
        };
        return result;
      }
    }
    return result;
  }
}
