import { getHeadings, wordCount } from './markdown';
self.onmessage = (event: MessageEvent<{ id: number; content: string }>) => {
  const { id, content } = event.data;
  self.postMessage({ id, headings: getHeadings(content), words: wordCount(content) });
};
