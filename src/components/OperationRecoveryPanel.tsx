import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/platform';
import type { Document } from '../lib/types';
import { pathKey } from '../lib/workspace';
import { t, useI18n } from '../lib/i18n';
type Item = { id: string; from: string; to: string; files: string[]; completed: boolean };
export default function OperationRecoveryPanel({
  documents,
  onRecovered,
}: {
  documents: () => Document[];
  onRecovered: (from: string, to: string) => void;
}) {
  useI18n();
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ item: Item; action: 'restore' | 'archive' }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    if (desktop)
      void invoke<Item[]>('reference_recovery_list')
        .then((items) => {
          if (!disposed) setItems(items);
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, [revision]);
  async function perform() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      const { item, action } = confirm;
      if (action === 'restore') {
        const paths = [item.from, item.to, ...item.files].map(pathKey);
        if (
          documents().some(
            (doc) =>
              doc.path &&
              paths.some(
                (path) => pathKey(doc.path!) === path || pathKey(doc.path!).startsWith(path + '/'),
              ) &&
              (doc.content !== doc.saved || doc.status === 'conflict' || doc.status === 'error'),
          )
        )
          throw new Error(
            t(
              '受影响文档还有未保存内容或冲突，请先保存或另存。',
              'Affected documents have unsaved edits/conflicts. Save or save as first.',
            ),
          );
        await invoke('reference_recover', { id: item.id });
        onRecovered(item.to, item.from);
      } else await invoke('reference_recovery_archive', { id: item.id });
      setConfirm(undefined);
      setRevision((n) => n + 1);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="preferences-section operation-recovery">
      <h4>{t('未完成文件操作', 'Interrupted file operations')}</h4>
      <p>
        {t(
          '检查批量改名或移动的恢复副本。恢复会核对当前文件，只回退仍匹配记录的内容；外部修改会阻止覆盖。',
          'Review recovery copies from interrupted moves or renames. Recovery checks current versions and refuses to overwrite external edits.',
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {items.length === 0 && <p>{t('没有待处理的恢复记录。', 'No pending recovery records.')}</p>}
      {items.map((item) => (
        <div className="operation-recovery-item" key={item.id}>
          <p>
            <code>{item.from}</code> → <code>{item.to}</code>
          </p>
          <small>
            {item.files.length} {t('个引用文档', 'referencing documents')}
          </small>
          <details>
            <summary>{t('受影响文件', 'Affected files')}</summary>
            {item.files.map((path) => (
              <p key={path}>{path}</p>
            ))}
          </details>
          <button
            disabled={busy}
            onClick={() =>
              void invoke('reference_recovery_reveal', { id: item.id }).catch((error) =>
                setError(String(error)),
              )
            }
          >
            {t('查看恢复副本', 'Inspect recovery copies')}
          </button>
          <button
            disabled={busy || item.completed}
            onClick={() => setConfirm({ item, action: 'restore' })}
          >
            {t('恢复原始内容及路径…', 'Restore contents and paths…')}
          </button>
          <button disabled={busy} onClick={() => setConfirm({ item, action: 'archive' })}>
            {t('保留现状并归档…', 'Keep current files and archive…')}
          </button>
        </div>
      ))}
      {confirm && (
        <div
          className="operation-recovery-confirm"
          role="group"
          aria-label={t('确认恢复操作', 'Confirm recovery action')}
        >
          <p>
            {confirm.action === 'restore'
              ? t(
                  '将检查并恢复所列内容及原始路径；恢复副本会保留归档。',
                  'Restore the listed content and original paths after validation. Recovery copies remain archived.',
                )
              : t(
                  '原文件不变，恢复记录及副本移入归档。',
                  'Keep current files unchanged and archive the recovery records and copies.',
                )}
          </p>
          <button disabled={busy} onClick={() => void perform()}>
            {t('确认', 'Confirm')}
          </button>
          <button disabled={busy} onClick={() => setConfirm(undefined)}>
            {t('取消', 'Cancel')}
          </button>
        </div>
      )}
      <button disabled={busy || !desktop} onClick={() => setRevision((n) => n + 1)}>
        {t('刷新记录', 'Refresh records')}
      </button>
    </section>
  );
}
