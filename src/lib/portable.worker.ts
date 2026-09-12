import { portableReferences } from './referenceMaintenance';
self.onmessage = (event: MessageEvent<{ path: string; content: string }>) => {
  try {
    self.postMessage({ resources: portableReferences(event.data) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
