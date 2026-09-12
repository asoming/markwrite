import { ReadingDocument } from './readingDocument';
import type { MarkdownParseOptions } from './markdownParser';
import type { ReadingBlock, ReadingChunk, ReadingSearch } from './readingTypes';

export type ReadingRequest =
  | { kind: 'load'; generation: number; source: string; options?: MarkdownParseOptions }
  | { kind: 'chunks'; generation: number; indices: number[] }
  | { kind: 'copy'; generation: number; request: number }
  | {
      kind: 'search';
      generation: number;
      request: number;
      query: string;
      index: number;
      caseSensitive: boolean;
    };
export type ReadingResponse =
  | {
      kind: 'loaded';
      generation: number;
      blocks: ReadingBlock[];
      chunks: ReadingChunk[];
      complete: boolean;
    }
  | { kind: 'chunks'; generation: number; chunks: ReadingChunk[] }
  | { kind: 'copy'; generation: number; request: number; parts: string[] }
  | { kind: 'search'; generation: number; request: number; result: ReadingSearch }
  | { kind: 'error'; generation: number; message: string };

let document: ReadingDocument | null = null,
  generation = 0;
const send = (message: ReadingResponse) => self.postMessage(message);
self.onmessage = (event: MessageEvent<ReadingRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'load') {
      generation = message.generation;
      document = new ReadingDocument(message.source, message.options, (blocks, chunks) =>
        send({ kind: 'loaded', generation, blocks, chunks, complete: false }),
      );
      send({
        kind: 'loaded',
        generation,
        blocks: document.blocks,
        chunks: document.read([0, 1, 2, 3, 4, 5, 6, 7]),
        complete: true,
      });
    } else if (message.generation === generation && document) {
      if (message.kind === 'chunks')
        send({ kind: 'chunks', generation, chunks: document.read(message.indices) });
      else if (message.kind === 'copy')
        send({
          kind: 'copy',
          generation,
          request: message.request,
          parts: document.clipboardParts,
        });
      else
        send({
          kind: 'search',
          generation,
          request: message.request,
          result: document.search(message.query, message.index, message.caseSensitive),
        });
    }
  } catch (error) {
    send({ kind: 'error', generation: message.generation, message: String(error) });
  }
};
