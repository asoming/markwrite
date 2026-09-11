import { backlinks, documentReferences, pathKey, type IndexedDocument } from './workspace';
import { deriveGraph, type DocumentGraph } from './documentGraph';

export type ReferenceSnapshot = {
  incoming: IndexedDocument[];
  outgoing: ReturnType<typeof documentReferences>['links'];
  tags: [string, IndexedDocument[]][];
  graph: DocumentGraph;
  documents: number;
};
export const emptyReferences = (): ReferenceSnapshot => ({
  incoming: [],
  outgoing: [],
  tags: [],
  graph: { neighbors: [], broken: [], ambiguous: [], repeatedReferences: 0, selfReferences: 0 },
  documents: 0,
});

/** Worker-owned index. Unchanged text is never lexed again on tab/current-file changes. */
export class ReferenceIndex {
  private disk: IndexedDocument[] = [];
  private parsed = new Map<
    string,
    { content: string; references: ReturnType<typeof documentReferences> }
  >();
  constructor(private parse = documentReferences) {}
  setDisk(documents: IndexedDocument[]) {
    this.disk = documents;
  }
  query(buffers: IndexedDocument[], currentPath: string): ReferenceSnapshot {
    const unique = new Map<string, IndexedDocument>();
    for (const doc of buffers)
      if (!unique.has(pathKey(doc.path))) unique.set(pathKey(doc.path), doc);
    for (const doc of this.disk)
      if (!unique.has(pathKey(doc.path))) unique.set(pathKey(doc.path), doc);
    const documents: IndexedDocument[] = [];
    const tags = new Map<string, IndexedDocument[]>();
    for (const [key, doc] of unique) {
      let value = this.parsed.get(key);
      if (!value || value.content !== doc.content) {
        value = { content: doc.content, references: this.parse(doc.content) };
        this.parsed.set(key, value);
      }
      // Only tiny metadata goes back through IPC; full document text stays in the worker.
      const item = { path: doc.path, name: doc.name, content: '', references: value.references };
      documents.push(item);
      for (const tag of value.references.tags) {
        const bucket = tags.get(tag);
        if (bucket) bucket.push(item);
        else tags.set(tag, [item]);
      }
    }
    for (const key of this.parsed.keys()) if (!unique.has(key)) this.parsed.delete(key);
    return {
      incoming: backlinks(currentPath, documents),
      outgoing:
        documents.find((d) => pathKey(d.path) === pathKey(currentPath))?.references?.links || [],
      tags: [...tags].sort((a, b) => a[0].localeCompare(b[0])),
      graph: deriveGraph(documents, currentPath),
      documents: documents.length,
    };
  }
}
