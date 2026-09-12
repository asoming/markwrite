import { useEffect, useState } from 'react';
import { findFiles } from './platform';

export function useQuickOpenFiles(active: boolean, path: string | undefined, query: string) {
  const scope = active && path ? JSON.stringify([path, query]) : '';
  const [result, setResult] = useState({
    scope: '',
    files: [] as { name: string; path: string }[],
    pending: false,
    error: '',
  });
  useEffect(() => {
    if (!scope || !path) return;
    const controller = new AbortController();
    setResult({ scope, files: [], pending: true, error: '' });
    const timeout = setTimeout(() => {
      void findFiles(path, query, crypto.randomUUID(), controller.signal).then(
        (files) => {
          if (!controller.signal.aborted) setResult({ scope, files, pending: false, error: '' });
        },
        (error) => {
          if (!controller.signal.aborted)
            setResult({ scope, files: [], pending: false, error: String(error) });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [scope, path, query]);
  return result.scope === scope ? result : { files: [], pending: !!scope, error: '' };
}
