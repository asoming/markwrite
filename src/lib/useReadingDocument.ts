import { useEffect, useRef, useState, useCallback } from 'react';
import { ReadingDocument } from './readingDocument';
import type { MarkdownParseOptions } from './markdownParser';
import type { ReadingRequest, ReadingResponse } from './reading.worker';
import type { ReadingBlock, ReadingChunk, ReadingSearch } from './readingTypes';

export const emptyReadingSearch = (): ReadingSearch => ({
  query: '',
  total: 0,
  index: -1,
  counts: [],
});
export function useReadingDocument(
  source: string,
  identity: string,
  options: MarkdownParseOptions | undefined,
  revision: number | undefined,
) {
  const initial = useRef<ReadingDocument | undefined>(undefined);
  if (typeof Worker === 'undefined' && !initial.current)
    initial.current = new ReadingDocument(source, options);
  const [blocks, setBlocks] = useState<ReadingBlock[]>(() => initial.current?.blocks || []);
  const [chunks, setChunks] = useState<Map<number, ReadingChunk>>(
    () =>
      new Map(initial.current?.read([0, 1, 2, 3, 4, 5, 6, 7]).map((chunk) => [chunk.index, chunk])),
  );
  const [complete, setComplete] = useState(!!initial.current);
  const [error, setError] = useState('');
  const [search, setSearch] = useState<ReadingSearch>(emptyReadingSearch);
  const [searching, setSearching] = useState(false);
  const [generation, setGeneration] = useState(0);
  const worker = useRef<Worker | null>(null);
  const fallback = useRef(initial.current);
  const serial = useRef(0),
    searchRequest = useRef(0);
  const copyRequest = useRef(0);
  const copies = useRef(
    new Map<number, { resolve: (parts: string[]) => void; reject: (reason: Error) => void }>(),
  );
  const requested = useRef(new Set<number>());
  const chunkCache = useRef(chunks);
  chunkCache.current = chunks;
  const optionsKey = JSON.stringify(options || {});
  const loaded = useRef({ source, identity, optionsKey, revision });
  const matchesCurrent =
    loaded.current.source === source &&
    loaded.current.identity === identity &&
    loaded.current.optionsKey === optionsKey &&
    loaded.current.revision === revision;

  useEffect(() => {
    const current = ++serial.current;
    loaded.current = { source, identity, optionsKey, revision };
    let disposed = false;
    searchRequest.current++;
    requested.current = new Set();
    setGeneration(current);
    setError('');
    setSearch(emptyReadingSearch());
    setSearching(false);
    const receive = (message: ReadingResponse) => {
      if (disposed || message.generation !== serial.current) return;
      if (message.kind === 'loaded') {
        setBlocks(message.blocks);
        setComplete(message.complete);
      }
      if (message.kind === 'loaded' || message.kind === 'chunks') {
        for (const chunk of message.chunks) requested.current.delete(chunk.index);
        setChunks((previous) => {
          const next = new Map(previous);
          for (const chunk of message.chunks) {
            next.delete(chunk.index);
            next.set(chunk.index, chunk);
          }
          while (next.size > 96) next.delete(next.keys().next().value!);
          return next;
        });
      } else if (message.kind === 'copy') {
        copies.current.get(message.request)?.resolve(message.parts);
        copies.current.delete(message.request);
      } else if (message.kind === 'search' && message.request === searchRequest.current) {
        setSearch(message.result);
        setSearching(false);
      } else if (message.kind === 'error') {
        setError(message.message);
        setComplete(true);
        setSearching(false);
        for (const pending of copies.current.values()) pending.reject(new Error(message.message));
        copies.current.clear();
      }
    };
    const useFallback = () => {
      try {
        fallback.current = new ReadingDocument(source, options);
        receive({
          kind: 'loaded',
          generation: current,
          blocks: fallback.current.blocks,
          chunks: fallback.current.read([0, 1, 2, 3, 4, 5, 6, 7]),
          complete: true,
        });
      } catch (error) {
        receive({ kind: 'error', generation: current, message: String(error) });
      }
    };
    setChunks(new Map());
    setBlocks([]);
    setComplete(false);
    if (typeof Worker === 'undefined') useFallback();
    else {
      try {
        const instance = new Worker(new URL('./reading.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.current = instance;
        fallback.current = undefined;
        instance.onmessage = (event: MessageEvent<ReadingResponse>) => receive(event.data);
        instance.onerror = () => {
          if (disposed) return;
          instance.terminate();
          worker.current = null;
          // A failed worker is visible. Do not silently parse a huge file on the UI thread.
          receive({
            kind: 'error',
            generation: current,
            message:
              '文档未完全显示，请切换源码模式查看原文。 / The document is not fully displayed. Open source mode to view the original text.',
          });
        };
        instance.postMessage({
          kind: 'load',
          generation: current,
          source,
          options: JSON.parse(optionsKey),
        } satisfies ReadingRequest);
      } catch {
        useFallback();
      }
    }
    return () => {
      disposed = true;
      for (const pending of copies.current.values())
        pending.reject(new DOMException('Document changed', 'AbortError'));
      copies.current.clear();
      worker.current?.terminate();
      worker.current = null;
      fallback.current = undefined;
    };
  }, [source, identity, optionsKey, revision]);

  const requestChunks = useCallback((indices: readonly number[]) => {
    const missing = indices.filter(
      (index) => !chunkCache.current.has(index) && !requested.current.has(index),
    );
    if (!missing.length) return;
    for (const index of missing) requested.current.add(index);
    if (fallback.current) {
      const found = fallback.current.read(missing);
      setChunks((previous) => {
        const next = new Map(previous);
        for (const chunk of found) {
          requested.current.delete(chunk.index);
          next.set(chunk.index, chunk);
        }
        while (next.size > 96) next.delete(next.keys().next().value!);
        return next;
      });
    } else
      worker.current?.postMessage({
        kind: 'chunks',
        generation: serial.current,
        indices: missing,
      } satisfies ReadingRequest);
  }, []);
  const requestSearch = useCallback((query: string, index = 0, caseSensitive = false) => {
    const request = ++searchRequest.current;
    setSearching(!!query);
    if (!query) {
      setSearch(emptyReadingSearch());
      setSearching(false);
      return;
    }
    if (fallback.current) {
      setSearch(fallback.current.search(query, index, caseSensitive));
      setSearching(false);
    } else if (worker.current)
      worker.current.postMessage({
        kind: 'search',
        generation: serial.current,
        request,
        query,
        index,
        caseSensitive,
      } satisfies ReadingRequest);
    else setSearching(false);
  }, []);
  const requestCopy = useCallback((): Promise<string[]> => {
    if (fallback.current) return Promise.resolve(fallback.current.clipboardParts);
    if (!worker.current)
      return Promise.reject(new Error('阅读解析尚未完成 / Reader is not available'));
    const request = ++copyRequest.current;
    return new Promise((resolve, reject) => {
      copies.current.set(request, { resolve, reject });
      worker.current!.postMessage({
        kind: 'copy',
        generation: serial.current,
        request,
      } satisfies ReadingRequest);
    });
  }, []);
  return {
    blocks: matchesCurrent ? blocks : [],
    chunks: matchesCurrent ? chunks : new Map<number, ReadingChunk>(),
    complete: matchesCurrent && complete,
    error,
    generation,
    requestChunks,
    search,
    searching,
    requestSearch,
    requestCopy,
  };
}
