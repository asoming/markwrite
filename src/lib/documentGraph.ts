import {
  documentReferences,
  fileName,
  pathKey,
  resolveDocumentLink,
  wikiResolver,
  withoutExtension,
  type IndexedDocument,
} from './workspace';
const displayName = (document: IndexedDocument) =>
  withoutExtension(document.name || fileName(document.path));

export type GraphNeighbor = {
  document: IndexedDocument;
  incoming: number;
  outgoing: number;
};
export type DocumentGraph = {
  current?: IndexedDocument;
  neighbors: GraphNeighbor[];
  broken: string[];
  ambiguous: { target: string; candidates: string[] }[];
  repeatedReferences: number;
  selfReferences: number;
};

/** A local, definite relationship graph; ambiguous titles never invent edges. */
export function deriveGraph(documents: IndexedDocument[], currentPath?: string): DocumentGraph {
  const byPath = new Map<string, IndexedDocument>();
  for (const document of documents) {
    const key = pathKey(document.path);
    // The workspace supplies live buffers first. Keep those ahead of disk copies.
    if (!byPath.has(key)) byPath.set(key, document);
  }
  const unique = [...byPath.values()];
  const resolveWiki = wikiResolver(unique);
  const currentKey = currentPath ? pathKey(currentPath) : '';
  const current = byPath.get(currentKey);
  const result: DocumentGraph = {
    current,
    neighbors: [],
    broken: [],
    ambiguous: [],
    repeatedReferences: 0,
    selfReferences: 0,
  };
  if (!current) return result;
  const neighbors = new Map<string, GraphNeighbor>();
  const resolveReference = (target: string, wiki: boolean, from: string) => {
    if (wiki) return resolveWiki(target, from);
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(target) &&
      !/^[a-z]:[\\/]/i.test(target) &&
      !/^file:\/\//i.test(target)
    )
      return null;
    let path: string;
    try {
      path = resolveDocumentLink(from, target).path;
    } catch {
      return [];
    }
    // Attachments and web links are not document nodes.
    if (/\.[^./\\]+$/.test(path) && !/\.(?:md|markdown)$/i.test(path)) return null;
    const document = byPath.get(pathKey(path));
    if (document) return [document];
    return [];
  };
  for (const source of unique) {
    const isCurrent = pathKey(source.path) === currentKey;
    for (const link of (source.references || documentReferences(source.content)).links) {
      const targets = resolveReference(link.target, link.wiki, source.path);
      if (!targets) continue;
      if (targets.length !== 1) {
        if (isCurrent) {
          if (!targets.length) result.broken.push(link.target);
          else
            result.ambiguous.push({
              target: link.target,
              candidates: targets.map((target) => target.path),
            });
        }
        continue;
      }
      const target = targets[0];
      const targetKey = pathKey(target.path);
      if (targetKey === currentKey && isCurrent) {
        result.selfReferences++;
        continue;
      }
      if (!isCurrent && targetKey !== currentKey) continue;
      const other = isCurrent ? target : source;
      const key = pathKey(other.path);
      let neighbor = neighbors.get(key);
      if (!neighbor) {
        neighbor = { document: other, incoming: 0, outgoing: 0 };
        neighbors.set(key, neighbor);
      }
      if (isCurrent) {
        if (neighbor.outgoing) result.repeatedReferences++;
        neighbor.outgoing++;
      } else neighbor.incoming++;
    }
  }
  result.neighbors = [...neighbors.values()].sort(
    (a, b) =>
      displayName(a.document).localeCompare(displayName(b.document), 'zh-CN') ||
      pathKey(a.document.path).localeCompare(pathKey(b.document.path)),
  );
  return result;
}
