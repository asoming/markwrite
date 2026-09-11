import { useId, useMemo } from 'react';
import {
  documentReferences,
  fileName,
  pathKey,
  wikiTargets,
  withoutExtension,
  type IndexedDocument,
} from '../lib/workspace';
import './linkgraph.css';

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
    if (wiki) return wikiTargets(target, from, unique);
    if (
      (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) ||
      target.startsWith('//')
    )
      return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(target.split('#')[0]);
    } catch {
      return [];
    }
    if (!decoded) return [byPath.get(pathKey(from))!];
    const base = from.replace(/\\/g, '/').replace(/[^/]+$/, '');
    const absolute = /^(?:[/\\]|[a-z]:[\\/])/i.test(decoded);
    const document = byPath.get(pathKey(absolute ? decoded : base + decoded));
    if (document) return [document];
    // Attachments and web links are not document nodes.
    if (/\.[^./\\]+$/.test(decoded) && !/\.(?:md|markdown)$/i.test(decoded)) return null;
    return [];
  };
  for (const source of unique) {
    const isCurrent = pathKey(source.path) === currentKey;
    for (const link of documentReferences(source.content).links) {
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

const displayName = (document: IndexedDocument) =>
  withoutExtension(document.name || fileName(document.path));
const truncate = (value: string, length: number) => {
  const letters = Array.from(value);
  return letters.length > length ? letters.slice(0, length - 1).join('') + '…' : value;
};
const direction = ({ incoming, outgoing }: GraphNeighbor) =>
  incoming && outgoing ? '互相引用' : incoming ? '引用本文' : '本文引用';

type Props = {
  documents: IndexedDocument[];
  currentPath?: string;
  onOpen: (path: string) => void;
};
export default function LinkGraph({ documents, currentPath, onOpen }: Props) {
  const graph = useMemo(() => deriveGraph(documents, currentPath), [documents, currentPath]);
  const markerId = `link-arrow-${useId().replace(/\W/g, '')}`;
  if (!graph.current)
    return <p className="linkgraph-empty">打开一篇文档，查看它与工作区的关系。</p>;
  const visible = graph.neighbors.slice(0, 20);
  const points = visible.map((neighbor, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / visible.length;
    return { neighbor, x: 180 + 132 * Math.cos(angle), y: 180 + 132 * Math.sin(angle), angle };
  });
  return (
    <section className="linkgraph" aria-label="当前文档关系">
      <p className="linkgraph-note">只展示当前文档的直接关系，箭头指向被引用的文档。</p>
      <svg
        className="linkgraph-diagram"
        viewBox="0 0 360 360"
        role="group"
        aria-label={`${displayName(graph.current)}的关系图，${graph.neighbors.length}篇相关文档`}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M1 1L7 4L1 7Z" />
          </marker>
        </defs>
        {points.map(({ neighbor, x, y, angle }) => {
          const dx = Math.cos(angle),
            dy = Math.sin(angle);
          return (
            <line
              key={neighbor.document.path}
              className={neighbor.outgoing ? 'outgoing' : 'incoming'}
              x1={180 + 52 * dx}
              y1={180 + 52 * dy}
              x2={x - 16 * dx}
              y2={y - 16 * dy}
              markerStart={neighbor.incoming ? `url(#${markerId})` : undefined}
              markerEnd={neighbor.outgoing ? `url(#${markerId})` : undefined}
            />
          );
        })}
        <g className="linkgraph-current">
          <title>
            {graph.current.name || fileName(graph.current.path)} · {graph.current.path}
          </title>
          <circle cx="180" cy="180" r="48" />
          <text x="180" y="176" textAnchor="middle">
            {truncate(displayName(graph.current), 7)}
          </text>
          <text x="180" y="195" textAnchor="middle" className="current-caption">
            当前文档
          </text>
        </g>
        {points.map(({ neighbor, x, y }) => (
          <g
            className="linkgraph-node"
            key={neighbor.document.path}
            role="button"
            tabIndex={0}
            aria-label={`打开 ${neighbor.document.name || fileName(neighbor.document.path)}，${direction(neighbor)}`}
            onClick={() => onOpen(neighbor.document.path)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(neighbor.document.path);
              }
            }}
          >
            <title>
              {neighbor.document.name || fileName(neighbor.document.path)} ·{' '}
              {neighbor.document.path} · {direction(neighbor)}
            </title>
            <circle cx={x} cy={y} r="13" />
            <text x={x} y={y + 29} textAnchor="middle">
              {truncate(displayName(neighbor.document), visible.length > 12 ? 4 : 7)}
            </text>
          </g>
        ))}
      </svg>
      {!graph.neighbors.length && (
        <p className="linkgraph-empty">还没有确定的关联文档。插入文档链接后，关系会出现在这里。</p>
      )}
      {!!graph.neighbors.length && (
        <>
          <p className="linkgraph-summary">
            {graph.neighbors.length} 篇相关文档
            {graph.neighbors.length > 20 ? ' · 图中显示前 20 篇，完整列表见下方' : ''}
          </p>
          <ul className="linkgraph-list" aria-label="相关文档列表">
            {graph.neighbors.map((neighbor) => (
              <li key={neighbor.document.path}>
                <button
                  onClick={() => onOpen(neighbor.document.path)}
                  title={neighbor.document.path}
                >
                  <span>
                    {neighbor.document.name || fileName(neighbor.document.path)}
                    <small>{neighbor.document.path}</small>
                  </span>
                  <em>{direction(neighbor)}</em>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!(graph.broken.length || graph.ambiguous.length) && (
        <details className="linkgraph-issues" open>
          <summary>
            本文链接：{graph.broken.length} 处未解析 · {graph.ambiguous.length} 处同名待选择
          </summary>
          {graph.broken.map((target, index) => (
            <p key={`broken-${index}`}>
              <code>{target}</code>
              <small>当前索引中找不到目标文档</small>
            </p>
          ))}
          {graph.ambiguous.map(({ target, candidates }, index) => (
            <div key={`ambiguous-${index}`}>
              <p>
                <code>{target}</code>
                <small>有 {candidates.length} 个同名目标，尚未计入连线</small>
              </p>
              {candidates.map((path) => (
                <button key={path} onClick={() => onOpen(path)} title={path}>
                  {path}
                </button>
              ))}
            </div>
          ))}
        </details>
      )}
      {!!(graph.repeatedReferences || graph.selfReferences) && (
        <p className="linkgraph-note">
          {graph.repeatedReferences} 处重复引用已合并 · {graph.selfReferences}{' '}
          处本文锚点或自引用未画入关系图
        </p>
      )}
    </section>
  );
}
