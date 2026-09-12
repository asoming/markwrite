import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { comparisonContext, type Comparison, type CompareRow } from '../lib/textComparison';
import { t, useI18n } from '../lib/i18n';
export default function TextComparison({
  before,
  after,
}: {
  before: { name: string; content: string };
  after: { name: string; content: string };
}) {
  useI18n();
  const [result, setResult] = useState<Comparison>();
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(new Set<number>());
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setResult(undefined);
    setActive(0);
    setExpanded(new Set());
    const worker = new Worker(new URL('../lib/textComparison.worker.ts', import.meta.url), {
      type: 'module',
    });
    const timer = setTimeout(() => {
      worker.terminate();
      setResult({ rows: [], hunks: 0, added: 0, removed: 0, error: 'timeout' });
    }, 5000);
    worker.onmessage = (event: MessageEvent<Comparison>) => {
      clearTimeout(timer);
      setResult(event.data);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      setResult({ rows: [], hunks: 0, added: 0, removed: 0, error: 'worker' });
    };
    worker.postMessage({ before: before.content, after: after.content });
    return () => {
      clearTimeout(timer);
      worker.terminate();
    };
  }, [before.content, after.content]);
  function jump(direction: number) {
    if (!result?.hunks) return;
    const next = (active + direction + result.hunks) % result.hunks;
    setActive(next);
    surface.current?.querySelector(`[data-hunk="${next}"]`)?.scrollIntoView({ block: 'center' });
  }
  function cell(row: CompareRow, side: 'left' | 'right') {
    const value = row[side],
      parts = row[side === 'left' ? 'leftParts' : 'rightParts'];
    return (
      <div
        className={`text-diff-cell ${row.kind === 'changed' && value !== undefined ? (side === 'left' ? 'removed' : 'added') : ''}`}
      >
        <span className="text-diff-number" aria-hidden="true">
          {row[side === 'left' ? 'leftLine' : 'rightLine'] ?? ''}
        </span>
        <pre>
          {parts
            ? parts.map((part, index) =>
                part.changed ? <mark key={index}>{part.text}</mark> : part.text,
              )
            : value}
          {value !== undefined && !value.endsWith('\n') && (
            <small className="text-diff-eof">{t('无行尾换行', 'No newline at end')}</small>
          )}
        </pre>
      </div>
    );
  }
  return (
    <div className="text-comparison">
      <div className="text-diff-tools">
        <span role="status">
          {!result
            ? t('正在计算文字差异…', 'Comparing text…')
            : result.error
              ? t('未完成差异计算', 'Comparison incomplete')
              : result.hunks
                ? t(
                    '{0} 处差异 · 新增 {1} 行 · 删除 {2} 行',
                    '{0} changes · {1} added lines · {2} removed lines',
                    [result.hunks, result.added, result.removed],
                  )
                : t('两篇文档的文字完全一致', 'The documents are identical')}
        </span>
        <button
          disabled={!result?.hunks}
          onClick={() => jump(-1)}
          title={t('上一处差异', 'Previous change')}
          aria-label={t('上一处差异', 'Previous change')}
        >
          <ArrowUp size={16} />
        </button>
        <span>{result?.hunks ? `${active + 1} / ${result.hunks}` : '—'}</span>
        <button
          disabled={!result?.hunks}
          onClick={() => jump(1)}
          title={t('下一处差异', 'Next change')}
          aria-label={t('下一处差异', 'Next change')}
        >
          <ArrowDown size={16} />
        </button>
      </div>
      <p className="panel-note">
        {t(
          '比较两篇文档当前的 Markdown 文字，包含未保存修改。红色为左侧删除，绿色为右侧新增；仅查看，不会覆盖文件。',
          'Compare current Markdown text, including unsaved changes. Red marks left-side deletions; green marks right-side additions. This view never overwrites either document.',
        )}
      </p>
      {result?.error ? (
        <p role="alert">
          {result.error === 'size'
            ? t(
                '两篇合计超过 200 万字符或 12,000 行，请继续使用并排阅读，或缩小文档后比较。',
                'The pair exceeds 2 million characters or 12,000 lines. Use side-by-side reading or compare smaller documents.',
              )
            : t(
                '差异计算未在限时内完成，请缩小文档后重试。',
                'Comparison did not finish within the time limit. Try smaller documents.',
              )}
        </p>
      ) : (
        <div className="text-diff-scroll" ref={surface}>
          <div className="text-diff-heading">
            <strong>{before.name}</strong>
            <strong>{after.name}</strong>
          </div>
          {result &&
            comparisonContext(result.rows, expanded).map((item) =>
              'row' in item ? (
                <div
                  key={item.index}
                  className={`text-diff-row ${item.row.hunk === active ? 'active' : ''}`}
                  data-hunk={item.row.hunk}
                >
                  {cell(item.row, 'left')}
                  {cell(item.row, 'right')}
                </div>
              ) : (
                <button
                  className="text-diff-fold"
                  key={`fold-${item.from}`}
                  onClick={() => setExpanded((old) => new Set([...old, item.from]))}
                >
                  {t('展开 {0} 行相同文字', 'Show {0} unchanged lines', [item.to - item.from])}
                </button>
              ),
            )}
        </div>
      )}
    </div>
  );
}
