import { decodeHTML } from 'entities';
import { renderMarkdownBlocks, type MarkdownParseOptions } from './markdownParser';
import { readingPlainText, ReadingSearchIndex } from './readingSearch';
import type { ReadingBlock, ReadingChunk } from './readingTypes';
import { balancedReadingBlocks, splitReadingBlock } from './readingBlocks';

export class ReadingDocument {
  readonly blocks: ReadingBlock[] = [];
  readonly chunks: ReadingChunk[] = [];
  readonly clipboardParts: string[] = [];
  private searchIndex: ReadingSearchIndex;
  constructor(
    source: string,
    options?: MarkdownParseOptions,
    firstScreen?: (blocks: ReadingBlock[], chunks: ReadingChunk[]) => void,
  ) {
    const searchable: { text: string; fromLine: number }[] = [];
    const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const rendered = balancedReadingBlocks(renderMarkdownBlocks(source, options), normalized);
    for (const complete of rendered) {
      this.clipboardParts.push(complete.html);
      for (const block of splitReadingBlock(complete)) {
        if (!block.html.trim()) continue;
        const index = this.blocks.length;
        const text = readingPlainText(block.html);
        const anchors = [
          ...block.html.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi),
        ].map((match) => decodeHTML(match[1] ?? match[2] ?? match[3]));
        const lines = Math.max(1, block.toLine - block.fromLine + 1);
        const estimatedHeight = /<(?:table|ul|ol|pre)\b/.test(block.html)
          ? Math.max(56, lines * 28 + 24)
          : /<img\b|data-diagram=/.test(block.html)
            ? 260
            : Math.max(52, Math.ceil(text.length / 72) * 32 + 28);
        this.blocks.push({
          index,
          fromLine: block.fromLine,
          toLine: Math.max(block.fromLine, block.toLine - 1),
          excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 160),
          characters: text.length,
          estimatedHeight,
          anchors,
        });
        this.chunks.push({ index, html: block.html, source: block.raw });
        searchable.push({ text, fromLine: block.fromLine });
        if (this.blocks.length === 8) firstScreen?.([...this.blocks], [...this.chunks]);
      }
    }
    this.searchIndex = new ReadingSearchIndex(searchable);
  }
  read(indices: readonly number[]) {
    return [...new Set(indices)].flatMap((index) =>
      this.chunks[index] ? [this.chunks[index]] : [],
    );
  }
  search(query: string, index = 0, caseSensitive = false) {
    return this.searchIndex.search(query, index, caseSensitive);
  }
}
