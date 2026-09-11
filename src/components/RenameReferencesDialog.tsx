import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { fileName } from '../lib/workspace';
import type { ReferenceChange, ReferenceWarning } from '../lib/referenceMaintenance';
import DiffView from './DiffView';
import './renameReferences.css';

export type RenameReferencesDialogProps = {
  from: string;
  to: string;
  changes: ReferenceChange[];
  warnings?: ReferenceWarning[];
  busy?: boolean;
  error?: string;
  onConfirm: (selectedPaths: string[]) => void;
  onCancel: () => void;
};
const pageSize = 20;

export default function RenameReferencesDialog({
  from,
  to,
  changes,
  warnings = [],
  busy = false,
  error,
  onConfirm,
  onCancel,
}: RenameReferencesDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const latest = useRef({ busy, onCancel });
  latest.current = { busy, onCancel };
  const [selected, setSelected] = useState(() => new Set(changes.map((change) => change.path)));
  const [active, setActive] = useState(changes[0]?.path || '');
  const [page, setPage] = useState(0);
  const [warningPage, setWarningPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(changes.length / pageSize));
  const current = changes.find((change) => change.path === active);
  const selectedChanges = changes.filter((change) => selected.has(change.path));
  const count = selectedChanges.reduce((sum, change) => sum + change.count, 0);
  useEffect(() => {
    setSelected(new Set(changes.map((change) => change.path)));
    setActive(changes[0]?.path || '');
    setPage(0);
    setWarningPage(0);
  }, [changes]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button,input')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onCancel();
      } else if (event.key === 'Tab') {
        const items = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
        );
        if (!items?.length) return;
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items[items.length - 1].focus();
        } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
          event.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      className="reference-dialog-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="reference-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('更新文件引用', 'Update file references')}
      >
        <header className="reference-dialog-heading">
          <div>
            <h2>{t('更新文件引用', 'Update file references')}</h2>
            <p title={`${from}\n→ ${to}`}>
              <span>{from}</span>
              <span>→ {to}</span>
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            aria-label={t('取消重命名', 'Cancel rename')}
            onClick={onCancel}
          >
            <X size={18} />
          </button>
        </header>
        <p className="reference-dialog-intro">
          {t(
            '检查将要修改的链接。所选文档将保存到磁盘，包含当前未保存的编辑；未选中的引用需要自行维护。检查范围为当前工作文件夹及已打开文档。',
            'Review the links to change. Selected documents will be saved, including unsaved edits. Unselected references may need manual repair. The check covers the current workspace and open documents.',
          )}
        </p>
        {!!warnings.length && (
          <details className="reference-warnings">
            <summary>
              {t('{0} 处引用需要手动检查', '{0} references need manual review', [warnings.length])}
            </summary>
            <ul>
              {warnings
                .slice(warningPage * pageSize, (warningPage + 1) * pageSize)
                .map((warning, index) => (
                  <li key={`${warning.path}:${index}`}>
                    <strong>{fileName(warning.path)}</strong>
                    <code>{warning.reference}</code>
                    <span>
                      {warning.reason === 'ambiguous-wiki'
                        ? t(
                            '存在同名文档，未自动修改。',
                            'Multiple documents share this name; left unchanged.',
                          )
                        : warning.reason === 'unsupported-target'
                          ? t(
                              '新路径无法用原链接语法安全表示，未自动修改。',
                              'The new path cannot be represented safely in this link syntax; left unchanged.',
                            )
                          : t(
                              '无法确认此引用，未自动修改。',
                              'This reference could not be verified; left unchanged.',
                            )}
                    </span>
                  </li>
                ))}
            </ul>
            {warnings.length > pageSize && (
              <div className="reference-pagination">
                <button
                  disabled={warningPage === 0}
                  onClick={() => setWarningPage((value) => value - 1)}
                  aria-label={t('上一页提示', 'Previous warning page')}
                >
                  <ChevronLeft size={15} />
                </button>
                <span>
                  {warningPage + 1} / {Math.ceil(warnings.length / pageSize)}
                </span>
                <button
                  disabled={(warningPage + 1) * pageSize >= warnings.length}
                  onClick={() => setWarningPage((value) => value + 1)}
                  aria-label={t('下一页提示', 'Next warning page')}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </details>
        )}
        {!!changes.length ? (
          <div className="reference-review-body">
            <aside className="reference-files">
              <label className="reference-select-all">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.size === changes.length}
                  onChange={(event) =>
                    setSelected(
                      new Set(event.target.checked ? changes.map((change) => change.path) : []),
                    )
                  }
                />
                {t('选择全部文档', 'Select all documents')}
              </label>
              <div className="reference-files-list">
                {changes.slice(page * pageSize, (page + 1) * pageSize).map((change) => (
                  <div
                    key={change.path}
                    className={`reference-file${active === change.path ? ' is-active' : ''}`}
                  >
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={selected.has(change.path)}
                      aria-label={t('更新 {0}', 'Update {0}', [change.path])}
                      onChange={(event) =>
                        setSelected((old) => {
                          const next = new Set(old);
                          if (event.target.checked) next.add(change.path);
                          else next.delete(change.path);
                          return next;
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-pressed={active === change.path}
                      title={change.path}
                      onClick={() => setActive(change.path)}
                    >
                      <FileText size={14} />
                      <span>
                        {fileName(change.path)}
                        <small>{change.path}</small>
                      </span>
                      <i>{change.count}</i>
                    </button>
                  </div>
                ))}
              </div>
              {totalPages > 1 && (
                <div className="reference-pagination">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((value) => value - 1)}
                    aria-label={t('上一页文档', 'Previous document page')}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span>
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    disabled={page + 1 >= totalPages}
                    onClick={() => setPage((value) => value + 1)}
                    aria-label={t('下一页文档', 'Next document page')}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </aside>
            <section
              className="reference-diff"
              aria-label={t('引用修改预览', 'Reference change preview')}
            >
              {current && (
                <>
                  <div className="reference-diff-heading">
                    <strong>{fileName(current.path)}</strong>
                    <span>{t('{0} 处引用', '{0} references', [current.count])}</span>
                  </div>
                  <DiffView before={current.before} after={current.after} />
                </>
              )}
            </section>
          </div>
        ) : (
          <p className="reference-empty">
            {t('没有需要自动修改的已知引用。', 'No known references need automatic changes.')}
          </p>
        )}
        {error && (
          <p className="reference-dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="reference-dialog-footer">
          <span>
            {t('已选择 {0} 份文档 · {1} 处引用', '{0} documents selected · {1} references', [
              selectedChanges.length,
              count,
            ])}
          </span>
          <button disabled={busy} onClick={onCancel}>
            {t('取消', 'Cancel')}
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => onConfirm(selectedChanges.map((change) => change.path))}
          >
            {busy ? t('正在更新…', 'Updating…') : t('确认并继续', 'Confirm and continue')}
          </button>
        </footer>
      </div>
    </div>
  );
}
