import { t, useI18n } from '../lib/i18n';
import { useId, useMemo, useState, useEffect } from 'react';
import { fileName, withoutExtension, type IndexedDocument } from '../lib/workspace';
import './linkgraph.css';

export { deriveGraph } from '../lib/documentGraph';
import { deriveGraph, type DocumentGraph, type GraphNeighbor } from '../lib/documentGraph';
const displayName = (document: IndexedDocument) =>
  withoutExtension(document.name || fileName(document.path));
const truncate = (value: string, length: number) => {
  const letters = Array.from(value);
  return letters.length > length ? letters.slice(0, length - 1).join('') + '…' : value;
};
const direction = ({ incoming, outgoing }: GraphNeighbor) =>
  incoming && outgoing ? t('互相引用') : incoming ? t('引用本文') : t('本文引用');

type Props = {
  documents: IndexedDocument[];
  preparedGraph?: DocumentGraph;
  currentPath?: string;
  onOpen: (path: string) => void;
};
export default function LinkGraph({ documents, currentPath, onOpen, preparedGraph }: Props) {
  useI18n();
  const graph = useMemo(
    () => preparedGraph || deriveGraph(documents, currentPath),
    [preparedGraph, documents, currentPath],
  );
  const [limit, setLimit] = useState(100);
  useEffect(() => setLimit(100), [currentPath]);
  const markerId = `link-arrow-${useId().replace(/\W/g, '')}`;
  if (!graph.current)
    return <p className="linkgraph-empty">{t('打开一篇文档，查看它与工作区的关系。')}</p>;
  const visible = graph.neighbors.slice(0, 20);
  const points = visible.map((neighbor, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / visible.length;
    return { neighbor, x: 180 + 132 * Math.cos(angle), y: 180 + 132 * Math.sin(angle), angle };
  });
  return (
    <section className="linkgraph" aria-label={t('当前文档关系')}>
      <p className="linkgraph-note">{t('只展示当前文档的直接关系，箭头指向被引用的文档。')}</p>
      <svg
        className="linkgraph-diagram"
        viewBox="0 0 360 360"
        role="group"
        aria-label={t('{0}的关系图，{1}篇相关文档', undefined, [
          displayName(graph.current),
          graph.neighbors.length,
        ])}
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
            {t('当前文档')}
          </text>
        </g>
        {points.map(({ neighbor, x, y }) => (
          <g
            className="linkgraph-node"
            key={neighbor.document.path}
            role="button"
            tabIndex={0}
            aria-label={t('打开 {0}，{1}', undefined, [
              neighbor.document.name || fileName(neighbor.document.path),
              direction(neighbor),
            ])}
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
        <p className="linkgraph-empty">
          {t('还没有确定的关联文档。插入文档链接后，关系会出现在这里。')}
        </p>
      )}
      {!!graph.neighbors.length && (
        <>
          <p className="linkgraph-summary">
            {graph.neighbors.length} {' ' + t('篇相关文档')}
            {graph.neighbors.length > 20 ? t(' · 图中显示前 20 篇，完整列表见下方') : ''}
          </p>
          <ul className="linkgraph-list" aria-label={t('相关文档列表')}>
            {graph.neighbors.slice(0, limit).map((neighbor) => (
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
          {graph.neighbors.length > limit && (
            <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
              {t('显示更多', 'Show more')}
            </button>
          )}
        </>
      )}
      {!!(graph.broken.length || graph.ambiguous.length) && (
        <details className="linkgraph-issues" open>
          <summary>
            {t('本文链接：')}
            {graph.broken.length} {' ' + t('处未解析 ·') + ' '}
            {graph.ambiguous.length} {' ' + t('处同名待选择')}
          </summary>
          {graph.broken.map((target, index) => (
            <p key={`broken-${index}`}>
              <code>{target}</code>
              <small>{t('当前索引中找不到目标文档')}</small>
            </p>
          ))}
          {graph.ambiguous.map(({ target, candidates }, index) => (
            <div key={`ambiguous-${index}`}>
              <p>
                <code>{target}</code>
                <small>
                  {t('有') + ' '}
                  {candidates.length} {' ' + t('个同名目标，尚未计入连线')}
                </small>
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
          {graph.repeatedReferences} {' ' + t('处重复引用已合并 ·') + ' '}
          {graph.selfReferences} {t('处本文锚点或自引用未画入关系图')}
        </p>
      )}
    </section>
  );
}
