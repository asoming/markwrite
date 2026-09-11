import { t, useI18n } from '../lib/i18n';
import { useMemo } from 'react';
import { diffLines } from 'diff';
export default function DiffView({ before, after }: { before: string; after: string }) {
  useI18n();
  const changes = useMemo(() => {
    if (before.length + after.length > 500_000) return null;
    return diffLines(before, after, { timeout: 300 });
  }, [before, after]);
  if (!changes)
    return (
      <div className="compare-columns">
        <pre>{before}</pre>
        <pre>{after}</pre>
      </div>
    );
  return (
    <pre className="diff-view" aria-label={t('版本差异')}>
      {changes.map((part, i) => (
        <span key={i} className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : ''}>
          {part.value.split(/(?<=\n)/).map((line, n) => (
            <span key={n} className="diff-line">
              <b aria-label={part.added ? t('新增') : part.removed ? t('删除') : t('未修改')}>
                {part.added ? '+' : part.removed ? '−' : ' '}
              </b>
              {line}
            </span>
          ))}
        </span>
      ))}
    </pre>
  );
}
