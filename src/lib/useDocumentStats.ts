import { useEffect, useRef, useState } from 'react';
import type { Heading } from './types';
export function useDocumentStats(content: string, documentId: string) {
  const [stats, setStats] = useState<{ headings: Heading[]; words: number }>({
    headings: [],
    words: 0,
  });
  const worker = useRef<Worker | undefined>(undefined);
  const generation = useRef(0),
    busy = useRef(false),
    pending = useRef<{ id: number; content: string } | undefined>(undefined);
  useEffect(() => {
    const instance = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = (
      event: MessageEvent<{ id: number; headings: Heading[]; words: number }>,
    ) => {
      busy.current = false;
      if (event.data.id === generation.current)
        setStats({ headings: event.data.headings, words: event.data.words });
      if (pending.current) {
        const next = pending.current;
        pending.current = undefined;
        busy.current = true;
        instance.postMessage(next);
      }
    };
    return () => {
      instance.terminate();
      worker.current = undefined;
      busy.current = false;
    };
  }, []);
  useEffect(() => {
    setStats({ headings: [], words: 0 });
  }, [documentId]);
  useEffect(() => {
    const id = ++generation.current;
    const timer = setTimeout(
      () => {
        const request = { id, content };
        if (busy.current) pending.current = request;
        else if (worker.current) {
          busy.current = true;
          worker.current.postMessage(request);
        }
      },
      content.length > 300_000 ? 500 : 100,
    );
    return () => clearTimeout(timer);
  }, [content, documentId]);
  return stats;
}
