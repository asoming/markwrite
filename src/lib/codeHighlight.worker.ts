import { codeTokens, type CodeToken } from './codeHighlightEngine';
const cache = new Map<string, Promise<CodeToken[]>>();

self.onmessage = async (event: MessageEvent<{ id: number; source: string; language: string }>) => {
  const { id, source, language } = event.data;
  try {
    const key = language + '\0' + source;
    let result = cache.get(key);
    if (!result) {
      result = codeTokens(source, language).catch(() => []);
      cache.set(key, result);
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
    }
    self.postMessage({ id, tokens: await result });
  } catch {
    self.postMessage({ id, tokens: [] });
  }
};
