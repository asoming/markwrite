import { compareText } from './textComparison';
self.onmessage = (event: MessageEvent<{ before: string; after: string }>) => {
  self.postMessage(compareText(event.data.before, event.data.after));
};
