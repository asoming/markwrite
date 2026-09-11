import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop, openExternal } from '../lib/platform';
type Update = {
  current: string;
  latest: string | null;
  available: boolean;
  releaseId: number | null;
  notes: string;
  url: string;
  asset: { name: string; size: number } | null;
};
type Download = { path: string; name: string; sha256: string };
export default function UpdatePanel({ language }: { language: 'zh-CN' | 'en' }) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh);
  const [token, setToken] = useState(''),
    [previews, setPreviews] = useState(true);
  const [info, setInfo] = useState<Update>(),
    [download, setDownload] = useState<Download>();
  const [busy, setBusy] = useState<'check' | 'download' | null>(null),
    [problem, setProblem] = useState('');
  const [progress, setProgress] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let stop: (() => void) | undefined;
    if (desktop)
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const unlisten = await listen<number>('update-download-progress', (e) => {
            if (alive.current) setProgress(e.payload);
          });
          if (alive.current) stop = unlisten;
          else unlisten();
        })
        .catch(() => {});
    return () => {
      alive.current = false;
      stop?.();
    };
  }, []);
  async function check() {
    setProblem('');
    setBusy('check');
    setInfo(undefined);
    setDownload(undefined);
    try {
      const result = await invoke<Update>('check_app_update', {
        token: token.trim() || null,
        previews,
      });
      if (alive.current) setInfo(result);
    } catch (e) {
      if (alive.current) setProblem(String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  async function fetchInstaller() {
    if (!info?.releaseId) return;
    setProblem('');
    setBusy('download');
    setProgress(0);
    try {
      const result = await invoke<Download>('download_app_update', {
        releaseId: info.releaseId,
        token: token.trim() || null,
      });
      if (alive.current) setDownload(result);
    } catch (e) {
      if (alive.current) setProblem(String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  return (
    <section className="preferences-section update-panel">
      <h3>{t('应用更新', 'Application updates')}</h3>
      <p className="preference-help">
        {t(
          '检查 GitHub 上的新版本，下载并校验安装包，再按提示安装。',
          'Check GitHub for a newer version, verify the download, and follow the installation steps.',
        )}
      </p>
      {!desktop && (
        <p>
          {t(
            '请在桌面版检查和下载更新。',
            'Check and download updates in the desktop application.',
          )}
        </p>
      )}
      <label className="preference-toggle">
        <input
          type="checkbox"
          checked={previews}
          onChange={(e) => setPreviews(e.target.checked)}
          disabled={!!busy}
        />
        {t('包含预览版本', 'Include preview releases')}
      </label>
      <details>
        <summary>{t('私有仓库访问', 'Private repository access')}</summary>
        <p className="preference-help">
          {t(
            '仅需要此仓库 Contents 读取权限。令牌只发给 api.github.com，不保存，关闭设置后清除。',
            'Only Contents read access to this repository is needed. The token is sent only to api.github.com, is never saved, and is cleared when Settings closes.',
          )}
        </p>
        <input
          type="password"
          autoComplete="off"
          aria-label={t('GitHub 只读令牌', 'GitHub read-only token')}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={!!busy}
        />
      </details>
      <div className="preference-preset-buttons">
        <button
          className="preference-button"
          onClick={() => void check()}
          disabled={!desktop || !!busy}
        >
          {busy === 'check' ? t('正在检查…', 'Checking…') : t('检查更新', 'Check for updates')}
        </button>
        <button
          className="preference-button"
          onClick={() =>
            void openExternal('https://github.com/asoming/markwrite/releases').catch((e) =>
              setProblem(String(e)),
            )
          }
        >
          {t('打开发布页', 'Open releases')}
        </button>
      </div>
      {problem && (
        <p role="alert" className="preference-error">
          {problem}
        </p>
      )}
      {info && (
        <div>
          <p role="status">
            {t('当前版本', 'Current version')} {info.current} ·{' '}
            {info.available
              ? t('可更新到', 'Update available')
              : t('没有更新的可用版本', 'No newer version available')}{' '}
            {info.available ? info.latest : ''}
          </p>
          {info.available && info.notes && (
            <details>
              <summary>{t('查看更新说明', 'Release notes')}</summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflow: 'auto',
                  font: 'inherit',
                }}
              >
                {info.notes}
              </pre>
            </details>
          )}
          {info.available && !info.asset && (
            <p>
              {t(
                '此发布没有当前系统的安装包，请查看发布页。',
                'This release has no installer for your platform. See the release page.',
              )}
            </p>
          )}
          {info.available && info.asset && !download && (
            <button
              className="preference-button"
              disabled={!!busy}
              onClick={() => void fetchInstaller()}
            >
              {busy === 'download'
                ? t('下载并校验中', 'Downloading and verifying')
                : t('下载安装包', 'Download installer')}{' '}
              · {(info.asset.size / 1024 / 1024).toFixed(1)} MB
            </button>
          )}
        </div>
      )}
      {busy === 'download' && (
        <div role="status">
          <progress max={100} value={progress} />
          <span> {progress}%</span>
        </div>
      )}
      {download && (
        <div role="status">
          <p>
            {t(
              '下载完成，SHA-256 校验通过。保存工作并退出 Markwrite，再打开安装包完成更新。',
              'Download verified with SHA-256. Save your work and quit Markwrite, then open the installer to finish updating.',
            )}
          </p>
          <p className="preference-help" style={{ overflowWrap: 'anywhere' }}>
            {download.path}
          </p>
          <button
            className="preference-button"
            onClick={() => void invoke('open_update_folder').catch((e) => setProblem(String(e)))}
          >
            {t('打开安装包所在文件夹', 'Show installer folder')}
          </button>
        </div>
      )}
    </section>
  );
}
