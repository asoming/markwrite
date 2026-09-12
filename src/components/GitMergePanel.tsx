import { useMemo, useState } from 'react';
import { t, useI18n } from '../lib/i18n';
import type { DiskFile } from '../lib/types';
import { mergeResult, splitMergeConflicts } from '../lib/mergeConflicts';
export type ConflictVersions = {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: DiskFile | null;
  indexVersion: string;
};
export default function GitMergePanel({
  file,
  versions,
  onSave,
  onClose,
  busy,
}: {
  file: string;
  versions: ConflictVersions;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}) {
  useI18n();
  const parts = useMemo(() => splitMergeConflicts(versions.working?.content || ''), [versions]);
  const [choices, setChoices] = useState<Record<number, 'ours' | 'theirs' | 'both' | 'base'>>({});
  const combined = mergeResult(parts, choices);
  const [manual, setManual] = useState<string>();
  const [error, setError] = useState('');
  const result = manual ?? combined;
  return (
    <div className="git-merge-panel">
      <h4>
        {t('三方比较与解决', 'Three-way resolution')} · {file}
      </h4>
      <div className="git-merge-versions">
        {(['base', 'ours', 'theirs'] as const).map((key, i) => (
          <details key={key}>
            <summary>
              {[t('共同基线', 'Base'), t('本地版本', 'Ours'), t('传入版本', 'Theirs')][i]}
            </summary>
            <pre>{versions[key] ?? t('此版本不存在文件', 'File absent in this version')}</pre>
          </details>
        ))}
      </div>
      {parts.map((part, index) =>
        'text' in part ? null : (
          <div key={index} className="git-merge-hunk">
            <div>
              <pre>{part.ours}</pre>
              <pre>{part.theirs}</pre>
            </div>
            {(
              ['ours', 'theirs', 'both', ...(part.base === undefined ? [] : ['base'])] as const
            ).map((choice) => (
              <button
                key={choice}
                disabled={busy}
                aria-pressed={choices[index] === choice}
                onClick={() => {
                  setManual(undefined);
                  setChoices((old) => ({ ...old, [index]: choice as 'ours' }));
                }}
              >
                {
                  (
                    {
                      ours: t('保留本地', 'Use ours'),
                      theirs: t('保留传入', 'Use theirs'),
                      both: t('保留双方', 'Use both'),
                      base: t('保留基线', 'Use base'),
                    } as Record<string, string>
                  )[choice]
                }
              </button>
            ))}
          </div>
        ),
      )}
      <div className="git-merge-actions">
        {(['ours', 'theirs', 'base'] as const).map((choice) => (
          <button
            disabled={busy || versions[choice] === null}
            key={choice}
            onClick={() => setManual(versions[choice]!)}
          >
            {t('整篇使用', 'Use entire')} {choice}
          </button>
        ))}
      </div>
      <label>
        {t('最终内容（可以继续修改）', 'Result (editable)')}
        <textarea
          aria-label={t('合并结果', 'Merge result')}
          value={result ?? versions.working?.content ?? ''}
          onChange={(event) => setManual(event.target.value)}
          rows={12}
        />
      </label>
      {result === null && (
        <p>
          {t(
            '请处理每一处冲突，或手动编辑最终内容。',
            'Choose each conflict or edit the result manually.',
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="git-merge-actions">
        <button
          disabled={busy || result === null}
          onClick={() => {
            if (result !== null) void onSave(result).catch((reason) => setError(String(reason)));
          }}
        >
          {t('保存解决结果', 'Save resolution')}
        </button>
        <button disabled={busy} onClick={onClose}>
          {t('取消', 'Cancel')}
        </button>
      </div>
      <p>
        {t(
          '保存后仍需标记已解决，再提交合并。磁盘或索引变化时会拒绝覆盖。',
          'After saving, mark resolved and commit the merge. Changed disk/index versions will not be overwritten.',
        )}
      </p>
    </div>
  );
}
