import { ReferenceIndex } from './referenceIndex';
import type { IndexedDocument } from './workspace';
export type IndexRequest = {
  id: number;
  disk?: IndexedDocument[];
  buffers: IndexedDocument[];
  currentPath: string;
};
const index = new ReferenceIndex();
self.onmessage = (event: MessageEvent<IndexRequest>) => {
  const { id, disk, buffers, currentPath } = event.data;
  try {
    if (disk) index.setDisk(disk);
    self.postMessage({ id, result: index.query(buffers, currentPath) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
