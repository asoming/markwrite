import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/platform';
import { t, useI18n } from '../lib/i18n';
import type { Document } from '../lib/types';
type Resource = {
  index: number;
  source: string;
  target?: string;
  size: number;
  status: string;
  message?: string;
};
type Plan = { id: string; documentName: string; assets: Resource[]; totalBytes: number };
export default function PortablePanel({
  current,
  onClose,
  onNotify,
}: {
  current: Document;
  onClose: () => void;
  onNotify: (text: string) => void;
}) {
  useI18n();
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [skip, setSkip] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () => () => {
      if (plan) void invoke('discard_portable', { id: plan.id }).catch(() => {});
    },
    [plan],
  );
  useEffect(() => {
    if (!desktop || !current.path) return;
    let canceled = false;
    setBusy(true);
    setPlan(undefined);
    setError('');
    setSkip(false);
    const worker = new Worker(new URL('../lib/portable.worker.ts', import.meta.url), {
      type: 'module',
    });
    const timer = setTimeout(() => {
      worker.terminate();
      if (!canceled) {
        setBusy(false);
        setError(
          t(
            '附件分析超时，请缩小文档后重试。',
            'Attachment analysis timed out. Try a smaller document.',
          ),
        );
      }
    }, 60_000);
    worker.onmessage = async (event) => {
      worker.terminate();
      clearTimeout(timer);
      try {
        if (event.data.error) throw new Error(event.data.error);
        const result = await invoke<Plan>('prepare_portable', {
          path: current.path,
          content: current.content,
          resources: event.data.resources,
        });
        if (!canceled) setPlan(result);
        else void invoke('discard_portable', { id: result.id }).catch(() => {});
      } catch (error) {
        if (!canceled) setError(String(error));
      } finally {
        if (!canceled) setBusy(false);
      }
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      if (!canceled) {
        setError(t('无法分析附件。', 'Could not analyze attachments.'));
        setBusy(false);
      }
    };
    worker.postMessage({ path: current.path, content: current.content });
    return () => {
      canceled = true;
      clearTimeout(timer);
      worker.terminate();
    };
  }, [current.path, current.content, attempt]);
  const unavailable = plan?.assets.filter((item) => item.status !== 'ready') || [];
  return (
    <div>
      <p className="preference-help">
        {t(
          '仅打包当前文档和它引用的本地附件。包内引用使用相对路径；磁盘上的原文与附件保持原样。',
          'Packages only this document and its referenced local attachments. References in the package are relative; the original document and assets stay unchanged.',
        )}
      </p>
      {(!desktop || !current.path) && (
        <p role="status">
          {t(
            '请在桌面版打开本地 Markdown 文件后使用。',
            'Open a local Markdown file in the desktop app to use this feature.',
          )}
        </p>
      )}
      {busy && (
        <p role="status">{t('正在处理文档与附件…', 'Processing document and attachments…')}</p>
      )}
      {plan && (
        <>
          <p>
            {plan.documentName} · {plan.assets.filter((item) => item.status === 'ready').length}{' '}
            {t('个附件', 'attachments')} · {(plan.totalBytes / 1024 / 1024).toFixed(1)} MiB
          </p>
          <div style={{ maxHeight: '40vh', overflow: 'auto' }}>
            {plan.assets.map((item) => (
              <p className="preference-help" key={item.index}>
                <strong>{item.source}</strong>
                <br />
                {item.status === 'ready' ? item.target : item.message || item.status}
              </p>
            ))}
          </div>
          {plan.assets.some((item) => item.status === 'denied') && (
            <button
              disabled={busy}
              onClick={async () => {
                try {
                  if (await invoke('authorize_asset_folder')) setAttempt((n) => n + 1);
                } catch (error) {
                  setError(String(error));
                }
              }}
            >
              {t('选择附件所在文件夹…', 'Choose attachment folder…')}
            </button>
          )}
          {!!unavailable.length && (
            <label className="preference-field">
              <span>
                {t(
                  '跳过以上不可用附件，并在包内保留问题清单',
                  'Skip unavailable attachments and include a manifest of omissions',
                )}
              </span>
              <input
                type="checkbox"
                checked={skip}
                onChange={(event) => setSkip(event.target.checked)}
              />
            </label>
          )}
          <div className="dialog-actions">
            <button
              className="primary"
              disabled={busy || (!!unavailable.length && !skip)}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const result = await invoke<{
                    path: string;
                    assetCount: number;
                    skippedCount: number;
                  } | null>('save_portable', { id: plan.id, skipUnavailable: skip });
                  if (result) {
                    onNotify(t('ZIP 已保存：', 'ZIP saved: ') + result.path);
                    onClose();
                  }
                } catch (error) {
                  setError(String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('导出 ZIP…', 'Export ZIP…')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </div>
  );
}
