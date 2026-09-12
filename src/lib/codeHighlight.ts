import type { CodeToken } from './codeHighlightEngine';
let worker: Worker | undefined;
let sequence = 0;
const waiting = new Map<number, (tokens: CodeToken[]) => void>();

function tokens(source: string, language: string): Promise<CodeToken[]> {
  if (source.length > 40_000 || typeof Worker === 'undefined') return Promise.resolve([]);
  try {
    if (!worker) {
      worker = new Worker(new URL('./codeHighlight.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<{ id: number; tokens: CodeToken[] }>) => {
        waiting.get(event.data.id)?.(event.data.tokens);
        waiting.delete(event.data.id);
      };
      worker.onerror = () => {
        for (const finish of waiting.values()) finish([]);
        waiting.clear();
        worker?.terminate();
        worker = undefined;
      };
    }
    const id = ++sequence;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        waiting.delete(id);
        resolve([]);
      }, 5000);
      waiting.set(id, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      worker!.postMessage({ id, source, language });
    });
  } catch {
    return Promise.resolve([]);
  }
}

/** Only text and generated spans enter the DOM; Markdown and code never become executable HTML. */
export async function highlightCodeBlocks(root: HTMLElement) {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice(9);
    if (!language || language === 'text' || code.dataset.highlighted) continue;
    const source = code.textContent || '';
    const spans = await tokens(source, language);
    if (!spans.length) continue;
    const content = document.createDocumentFragment();
    let position = 0;
    for (const token of spans) {
      content.append(document.createTextNode(source.slice(position, token.from)));
      const span = document.createElement('span');
      span.className = token.classes;
      span.textContent = source.slice(token.from, token.to);
      content.append(span);
      position = token.to;
    }
    content.append(document.createTextNode(source.slice(position)));
    code.replaceChildren(content);
    code.dataset.highlighted = 'true';
  }
}
