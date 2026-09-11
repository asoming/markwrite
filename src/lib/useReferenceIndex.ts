import { useEffect, useRef, useState } from 'react';
import { emptyReferences, type ReferenceSnapshot } from './referenceIndex';
import type { IndexedDocument } from './workspace';
import type { IndexRequest } from './references.worker';

export function useReferenceIndex(
  disk: IndexedDocument[],
  buffers: IndexedDocument[],
  currentPath: string,
  enabled: boolean,
) {
  const [result, setResult] = useState<ReferenceSnapshot>(emptyReferences);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const running = useRef<number | null>(null);
  const queued = useRef<IndexRequest | null>(null);
  const lastDisk = useRef<IndexedDocument[] | null>(null);
  const lastBuffers = useRef<IndexedDocument[]>([]);
  const lastPath = useRef('');
  const wasEnabled = useRef(false);
  const send = useRef<(request: IndexRequest) => void>(() => {});
  function resetSnapshot() {
    lastDisk.current = null;
    lastBuffers.current = [];
    lastPath.current = '';
  }

  useEffect(() => {
    let instance: Worker;
    let disposed = false;
    try {
      instance = new Worker(new URL('./references.worker.ts', import.meta.url), { type: 'module' });
    } catch (failure) {
      setPending(false);
      setResult(emptyReferences());
      setError(String(failure));
      return;
    }
    worker.current = instance;
    function failed(reason?: unknown) {
      if (disposed || worker.current !== instance) return;
      generation.current++;
      running.current = null;
      queued.current = null;
      resetSnapshot();
      setResult(emptyReferences());
      setPending(false);
      setError(
        reason
          ? String(reason)
          : '后台索引无法运行，请重新打开面板。 / Background index failed. Reopen the panel.',
      );
      instance.onmessage = null;
      instance.onerror = null;
      instance.terminate();
      worker.current = null;
    }
    send.current = (request) => {
      if (disposed || worker.current !== instance) return;
      try {
        running.current = request.id;
        instance.postMessage(request);
      } catch (failure) {
        failed(failure);
      }
    };
    instance.onmessage = (
      event: MessageEvent<{ id: number; result?: ReferenceSnapshot; error?: string }>,
    ) => {
      if (disposed || worker.current !== instance || event.data.id !== running.current) return;
      running.current = null;
      if (event.data.id === generation.current) {
        setResult(event.data.result || emptyReferences());
        setError(event.data.error || '');
        setPending(false);
      }
      if (queued.current) {
        const next = queued.current;
        queued.current = null;
        send.current(next);
      }
    };
    instance.onerror = () => failed();
    return () => {
      disposed = true;
      generation.current++;
      instance.onmessage = null;
      instance.onerror = null;
      instance.terminate();
      if (worker.current === instance) worker.current = null;
      running.current = null;
      queued.current = null;
      resetSnapshot();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      generation.current++;
      queued.current = null;
      resetSnapshot();
      setPending(false);
      if (wasEnabled.current) setResult(emptyReferences());
      wasEnabled.current = false;
      return;
    }
    wasEnabled.current = true;
    if (!worker.current) return;
    const sameBuffers =
      buffers.length === lastBuffers.current.length &&
      buffers.every((document, index) => {
        const previous = lastBuffers.current[index];
        return (
          document.path === previous.path &&
          document.name === previous.name &&
          document.content === previous.content
        );
      });
    if (lastDisk.current === disk && sameBuffers && lastPath.current === currentPath) return;
    const id = ++generation.current;
    if (lastDisk.current !== disk || lastPath.current !== currentPath) setResult(emptyReferences());
    setPending(true);
    setError('');
    const timer = setTimeout(
      () => {
        const request: IndexRequest = { id, buffers, currentPath };
        if (lastDisk.current !== disk) request.disk = disk;
        lastDisk.current = disk;
        lastBuffers.current = buffers;
        lastPath.current = currentPath;
        if (running.current !== null) {
          // A later buffer edit must carry a root refresh that has not reached the worker yet.
          queued.current = { ...request, disk: request.disk || queued.current?.disk };
        } else send.current(request);
      },
      sameBuffers ? 0 : 150,
    );
    return () => clearTimeout(timer);
  }, [disk, buffers, currentPath, enabled]);
  return { result, pending, error };
}
