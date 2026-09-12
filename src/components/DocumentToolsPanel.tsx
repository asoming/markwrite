import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { t, useI18n } from '../lib/i18n';
import type { DiskFile, Document, TextEncoding } from '../lib/types';

type WindowRecord = { id: string; path?: string; createdAtMs: number; hasSession: boolean };
export default function DocumentToolsPanel({
  kind,
  current,
  onOpen,
  onClose,
}: {
  kind: 'encoding' | 'windows';
  current: Document;
  onOpen: (file: DiskFile) => void;
  onClose: () => void;
}) {
  useI18n();
  const [path, setPath] = useState(current.path);
  const [encoding, setEncoding] = useState<TextEncoding>(current.encoding || 'utf-8');
  const [preview, setPreview] = useState<DiskFile>();
  const [windows, setWindows] = useState<WindowRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      generation.current++;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const id = ++generation.current;
    setError('');
    setPreview(undefined);
    if (kind === 'windows') {
      setBusy(true);
      void invoke<WindowRecord[]>('list_document_windows')
        .then(
          (items) => {
            if (generation.current === id) setWindows(items);
          },
          (error) => {
            if (generation.current === id) setError(String(error));
          },
        )
        .finally(() => {
          if (generation.current === id) setBusy(false);
        });
    } else if (path) {
      setBusy(true);
      void invoke<DiskFile>('read_with_encoding', { path, encoding })
        .then(
          (file) => {
            if (generation.current === id) setPreview(file);
          },
          (error) => {
            if (generation.current === id) setError(String(error));
          },
        )
        .finally(() => {
          if (generation.current === id) setBusy(false);
        });
    }
  }, [kind, path, encoding]);
  const title =
    kind === 'encoding'
      ? t('选择编码预览', 'Preview text encoding')
      : t('恢复独立窗口', 'Restore independent windows');
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal wide"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const items = panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),select',
          );
          if (!items?.length) return;
          const first = items[0],
            last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label={t('关闭', 'Close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {kind === 'encoding' ? (
          <>
            <p className="preference-help">
              {t(
                '预览不写入文件。采用后使用所选编码编辑和保存；无法编码的字符会阻止保存。',
                'Preview does not write to the file. The chosen encoding is retained when editing and saving; unencodable characters prevent saving.',
              )}
            </p>
            <div className="dialog-actions">
              <button
                disabled={busy}
                onClick={async () => {
                  try {
                    const value = await invoke<string | null>('choose_file_for_encoding');
                    if (value) setPath(value);
                  } catch (error) {
                    setError(String(error));
                  }
                }}
              >
                {t('选择文件…', 'Choose file…')}
              </button>
              <select
                aria-label={t('文本编码', 'Text encoding')}
                value={encoding}
                onChange={(event) => setEncoding(event.target.value as TextEncoding)}
              >
                {(['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'gbk'] as const).map((value) => (
                  <option key={value} value={value}>
                    {value.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <p className="preference-help">{path || t('请选择本地文件', 'Choose a local file')}</p>
            {preview && (
              <pre
                className="encoding-preview"
                style={{
                  maxHeight: '45vh',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  padding: 16,
                  background: 'var(--panel)',
                  borderRadius: 8,
                }}
              >
                {preview.content.slice(0, 24000)}
                {preview.content.length > 24000 ? '\n…' : ''}
              </pre>
            )}
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={!preview || busy}
                onClick={() => {
                  if (preview) {
                    onOpen({ ...preview, encoding });
                    onClose();
                  }
                }}
              >
                {t('采用此编码打开', 'Open with this encoding')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="preference-help">
              {t(
                '每个窗口独立运行并保留自己的草稿。关闭或意外退出后，可以从这里重新打开。',
                'Each window runs independently and retains its own drafts. Reopen a window here after closing it or after a crash.',
              )}
            </p>
            {windows
              .filter((item) => item.hasSession)
              .map((item) => (
                <button
                  className="tree-row"
                  key={item.id}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await invoke('reopen_document_window', { id: item.id });
                    } catch (error) {
                      setError(String(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <span>
                    {item.path?.replace(/\\/g, '/').split('/').pop() ||
                      t('独立草稿', 'Independent draft')}
                  </span>
                  <small>{new Date(item.createdAtMs).toLocaleString()}</small>
                </button>
              ))}
            {!busy && !windows.some((item) => item.hasSession) && (
              <p>{t('还没有可恢复的独立窗口。', 'No independent windows to restore yet.')}</p>
            )}
          </>
        )}
        {busy && <p role="status">{t('正在读取…', 'Loading…')}</p>}
        {error && (
          <p role="alert" className="settings-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
