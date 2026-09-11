import { analyzeReferenceChanges, type ReferenceDocument } from './referenceMaintenance';
self.onmessage = (
  event: MessageEvent<{ documents: ReferenceDocument[]; from: string; to: string }>,
) => {
  try {
    self.postMessage({
      result: analyzeReferenceChanges(event.data.documents, event.data.from, event.data.to),
    });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
