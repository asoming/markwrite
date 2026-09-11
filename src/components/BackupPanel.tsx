import { useEffect, useRef, useState } from 'react';
import { Archive, FolderOpen, RefreshCw } from 'lucide-react';
import {
  backupApi,
  backupChangedEvent,
  formatBackupSize,
  type BackupConfig,
  type BackupInspection,
  type BackupRestored,
  type BackupSummary,
} from '../lib/backup';
import type { Language } from '../lib/types';
import './backup.css';

export type BackupBundle = () => unknown | Promise<unknown>;
export type BackupPanelProps = {
  language: Language;
  root?: string;
  getBundle: BackupBundle;
  onRestored: (result: BackupRestored) => void | Promise<void>;
};
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function BackupPanel({ language, root, getBundle, onRestored }: BackupPanelProps) {
  const [config, setConfig] = useState<BackupConfig>();
  const [snapshots, setSnapshots] = useState<BackupSummary[]>([]);
  const [inspection, setInspection] = useState<BackupInspection>();
  const [restoreSettings, setRestoreSettings] = useState(true);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [restoredPath, setRestoredPath] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const working = useRef(false);
  const t = (zh: string, en: string) => (language === 'en' ? en : zh);
  const available = backupApi.available();
  const date = (ms: number) =>
    Number.isFinite(new Date(ms).getTime())
      ? new Date(ms).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')
      : t('日期未知', 'Unknown date');
  const isoDate = (ms: number) =>
    Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined;

  async function refresh() {
    if (!available) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const [currentConfig, currentSnapshots] = await Promise.all([
        backupApi.config(),
        backupApi.list(),
      ]);
      if (!mounted.current || request !== generation.current) return;
      setConfig(currentConfig);
      setSnapshots(currentSnapshots);
    } catch (reason) {
      if (mounted.current && request === generation.current) setError(describeError(reason));
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const update = () => void refresh();
    window.addEventListener(backupChangedEvent, update);
    return () => {
      mounted.current = false;
      generation.current++;
      window.removeEventListener(backupChangedEvent, update);
    };
  }, [available]);

  async function run(action: string, operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(action);
    setError('');
    setSuccess('');
    setRestoredPath('');
    try {
      await operation();
    } catch (reason) {
      if (mounted.current) setError(describeError(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function updateSchedule(enabled: boolean, intervalHours: number) {
    await run('schedule', async () => {
      const updated = await backupApi.schedule(enabled, intervalHours);
      if (mounted.current) setConfig(updated);
    });
  }
  function prepareRestore(value: BackupInspection | null) {
    if (value && mounted.current) {
      setInspection(value);
      setRestoreSettings(value.summary.settingsIncluded);
    }
  }

  return (
    <section className="preferences-section backup-panel">
      <div className="backup-heading">
        <h4>{t('备份与恢复', 'Backup and restore')}</h4>
        {available && (
          <button
            type="button"
            className="backup-icon-button"
            disabled={loading || !!busy}
            aria-label={t('刷新备份列表', 'Refresh backups')}
            onClick={() => {
              setError('');
              void refresh();
            }}
          >
            <RefreshCw size={15} />
          </button>
        )}
      </div>
      <p className="preference-help">
        {t(
          '将当前文件夹中的 Markdown、图片及应用设置保存为独立快照。备份默认关闭，可随时手动创建。未保存的编辑和草稿不会写入磁盘快照，请先保存文档。',
          'Save the current folder’s Markdown files, images, and app preferences in independent snapshots. Backups are off by default and can be created manually. Unsaved edits and drafts are not included in disk snapshots; save your documents first.',
        )}
      </p>
      {!available ? (
        <p className="preference-help">
          {t(
            '本地目录备份仅在桌面版中可用。',
            'Local folder backups are available in the desktop app.',
          )}
        </p>
      ) : (
        <>
          {loading && !config && (
            <p role="status">{t('正在读取备份设置…', 'Loading backup preferences…')}</p>
          )}
          <div className="backup-path-row">
            <span>{t('当前文件夹', 'Current folder')}</span>
            <code title={root}>{root || t('请先打开文件夹', 'Open a folder first')}</code>
          </div>
          <div className="backup-path-row">
            <span>{t('备份位置', 'Backup location')}</span>
            <code title={config?.destination || undefined}>
              {config?.destination || t('尚未选择', 'Not selected')}
            </code>
            <button
              type="button"
              className="preference-button"
              disabled={!!busy}
              onClick={() =>
                void run('destination', async () => {
                  const value = await backupApi.chooseDestination();
                  if (value && mounted.current) {
                    setConfig(value);
                    setInspection(undefined);
                    await refresh();
                  }
                })
              }
            >
              <FolderOpen size={14} /> {t('选择位置', 'Choose location')}
            </button>
          </div>
          <p className="preference-help">
            {t(
              '设置、主题及扩展随快照保存；访问令牌、密码和密钥不包含在内。',
              'Preferences, themes, and extensions are included. Access tokens, passwords, and secret keys are excluded.',
            )}
          </p>
          <button
            type="button"
            className="preference-button backup-create"
            disabled={!root || !config?.destination || !!busy}
            onClick={() =>
              void run('create', async () => {
                if (!root) return;
                const snapshot = await backupApi.create(root, await getBundle());
                if (mounted.current) {
                  setSuccess(
                    t(
                      `备份完成：${snapshot.fileCount} 个文件，${formatBackupSize(snapshot.totalBytes)}。`,
                      `Backup complete: ${snapshot.fileCount} files, ${formatBackupSize(snapshot.totalBytes)}.`,
                    ),
                  );
                  await refresh();
                }
              })
            }
          >
            <Archive size={14} />{' '}
            {busy === 'create' ? t('正在备份…', 'Backing up…') : t('立即备份', 'Back up now')}
          </button>
          <label className="preference-toggle backup-schedule-toggle">
            <input
              type="checkbox"
              aria-label={t('启用定期备份', 'Enable scheduled backups')}
              checked={config?.enabled || false}
              disabled={!config?.destination || (!root && !config?.enabled) || !!busy}
              onChange={(event) =>
                void updateSchedule(event.target.checked, config?.intervalHours || 24)
              }
            />
            <span>{t('启用定期备份', 'Enable scheduled backups')}</span>
          </label>
          <label className="preference-field backup-interval">
            <span>{t('备份间隔', 'Backup interval')}</span>
            <select
              aria-label={t('备份间隔', 'Backup interval')}
              value={config?.intervalHours || 24}
              disabled={!config || !!busy}
              onChange={(event) =>
                void updateSchedule(config?.enabled || false, Number(event.target.value))
              }
            >
              {[...new Set([1, 6, 12, 24, 48, 168, config?.intervalHours || 24])]
                .sort((a, b) => a - b)
                .map((hours) => (
                  <option key={hours} value={hours}>
                    {t(`每 ${hours} 小时`, `Every ${hours} hours`)}
                  </option>
                ))}
            </select>
          </label>
          <p className="preference-help">
            {t(
              '仅在 Markwrite 运行且已打开文件夹时检查，每分钟检查一次。关闭应用期间不会执行，重新打开后会补上到期备份。',
              'Checked once a minute while Markwrite is running with a folder open. No backups run while the app is closed; an overdue backup runs after reopening.',
            )}
          </p>
          <dl className="backup-timing">
            <div>
              <dt>{t('上次成功', 'Last successful backup')}</dt>
              <dd>
                {config?.lastBackupAtMs
                  ? date(config.lastBackupAtMs)
                  : t('尚无成功备份', 'No successful backup yet')}
              </dd>
            </div>
            <div>
              <dt>{t('下次计划', 'Next scheduled backup')}</dt>
              <dd>
                {config?.enabled && config.nextBackupAtMs
                  ? `${date(config.nextBackupAtMs)}${!root ? t('（等待打开文件夹）', ' (waiting for an open folder)') : ''}`
                  : t('未启用', 'Not enabled')}
              </dd>
            </div>
          </dl>
          {config?.lastError && (
            <p className="backup-last-error">
              {t('最近备份失败：', 'Last backup failed: ')}
              {config.lastError}
            </p>
          )}
          {error && (
            <p role="alert" className="backup-error">
              {error}
            </p>
          )}
          {success && (
            <p role="status" className="backup-success">
              {success}
            </p>
          )}
          {restoredPath && (
            <p className="backup-restored-path">
              <strong>{t('恢复目录', 'Restored folder')}</strong>
              <code>{restoredPath}</code>
            </p>
          )}
          <div className="backup-list-heading">
            <h5>{t('备份快照', 'Snapshots')}</h5>
            <button
              type="button"
              disabled={!!busy}
              onClick={() =>
                void run('inspect', async () => prepareRestore(await backupApi.chooseSnapshot()))
              }
            >
              {t('从其他位置恢复…', 'Restore from another location…')}
            </button>
          </div>
          <div className="backup-list">
            {snapshots.map((snapshot) => (
              <div className="backup-snapshot" key={snapshot.id}>
                <div>
                  <strong>{snapshot.workspaceName}</strong>
                  <time dateTime={isoDate(snapshot.createdAtMs)}>{date(snapshot.createdAtMs)}</time>
                  <small>
                    {snapshot.markdownCount} Markdown ·{' '}
                    {t(`${snapshot.imageCount} 张图片`, `${snapshot.imageCount} images`)} ·{' '}
                    {formatBackupSize(snapshot.totalBytes)}
                  </small>
                </div>
                <button
                  type="button"
                  className="preference-button"
                  disabled={!!busy}
                  aria-label={`${t('预览恢复', 'Preview restore')} ${snapshot.id}`}
                  onClick={() =>
                    void run('inspect', async () =>
                      prepareRestore(await backupApi.inspect(snapshot.path)),
                    )
                  }
                >
                  {t('预览恢复', 'Preview restore')}
                </button>
              </div>
            ))}
            {!snapshots.length && (
              <p className="preference-help">
                {t('此位置暂无备份。', 'No snapshots at this location.')}
              </p>
            )}
          </div>
          {inspection && (
            <section
              className="backup-restore-preview"
              aria-label={t('恢复前确认', 'Review before restoring')}
            >
              <h5>{t('恢复前确认', 'Review before restoring')}</h5>
              <p>
                {inspection.summary.workspaceName} · {date(inspection.summary.createdAtMs)}
              </p>
              <p>
                {t(
                  `${inspection.summary.fileCount} 个文件，${formatBackupSize(inspection.summary.totalBytes)}。`,
                  `${inspection.summary.fileCount} files, ${formatBackupSize(inspection.summary.totalBytes)}.`,
                )}
              </p>
              <p className="preference-help">
                {t(
                  '下一步选择恢复位置。会在该位置新建 Markwrite-restored 文件夹，不会覆盖已有文档。',
                  'Choose a restore location next. A new Markwrite-restored folder will be created there; existing documents will not be overwritten.',
                )}
              </p>
              {inspection.summary.skippedFiles > 0 && (
                <p className="preference-help">
                  {t(
                    `快照创建时跳过了 ${inspection.summary.skippedFiles} 个不支持的文件。`,
                    `${inspection.summary.skippedFiles} unsupported files were skipped when the snapshot was created.`,
                  )}
                </p>
              )}
              <details>
                <summary>
                  {t('查看文件清单', 'View file list')} ({inspection.files.length})
                </summary>
                <ul>
                  {inspection.files.slice(0, 100).map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>
                      <span>{formatBackupSize(file.size)}</span>
                    </li>
                  ))}
                </ul>
                {inspection.files.length > 100 && (
                  <p className="preference-help">
                    {t(
                      '显示前 100 个文件；恢复包含全部文件。',
                      'Showing the first 100 files. All files will be restored.',
                    )}
                  </p>
                )}
              </details>
              {inspection.summary.settingsIncluded && (
                <label className="preference-toggle">
                  <input
                    type="checkbox"
                    aria-label={t('同时恢复应用设置', 'Also restore app preferences')}
                    checked={restoreSettings}
                    disabled={!!busy}
                    onChange={(event) => setRestoreSettings(event.target.checked)}
                  />
                  <span>
                    {t(
                      '同时恢复应用设置、主题与扩展',
                      'Also restore app preferences, themes, and extensions',
                    )}
                  </span>
                </label>
              )}
              <div className="backup-restore-actions">
                <button
                  type="button"
                  className="preference-button"
                  disabled={!!busy}
                  onClick={() =>
                    void run('restore', async () => {
                      const restored = await backupApi.restore(inspection.summary.path);
                      if (!restored) return;
                      if (mounted.current) {
                        setRestoredPath(restored.path);
                        setInspection(undefined);
                      }
                      try {
                        await onRestored({
                          ...restored,
                          settingsBundle: restoreSettings ? restored.settingsBundle : null,
                        });
                        if (mounted.current)
                          setSuccess(
                            t('备份已恢复到新文件夹。', 'Snapshot restored to a new folder.'),
                          );
                      } catch (reason) {
                        if (mounted.current)
                          setError(
                            t(
                              `文件已恢复，但未能打开或应用设置：${describeError(reason)}`,
                              `Files were restored, but opening the folder or applying preferences failed: ${describeError(reason)}`,
                            ),
                          );
                      }
                    })
                  }
                >
                  {busy === 'restore'
                    ? t('正在恢复…', 'Restoring…')
                    : t('选择恢复位置并恢复', 'Choose location and restore')}
                </button>
                <button type="button" disabled={!!busy} onClick={() => setInspection(undefined)}>
                  {t('取消', 'Cancel')}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** One scheduler per app window; native create has a process-wide lock. No
 * filesystem access or bundle collection occurs unless a due schedule is on. */
export function BackupScheduler({
  root,
  getBundle,
  onNotify,
  language = 'zh-CN',
}: {
  root?: string;
  getBundle: BackupBundle;
  onNotify: (message: string, error?: boolean) => void;
  language?: Language;
}) {
  const current = useRef({ root, getBundle, onNotify, language });
  current.current = { root, getBundle, onNotify, language };
  useEffect(() => {
    if (!backupApi.available()) return;
    let active = true;
    let running = false;
    let lastError = '';
    const due = (config: BackupConfig) =>
      config.enabled &&
      !!config.destination &&
      config.nextBackupAtMs !== null &&
      config.nextBackupAtMs <= Date.now();
    const tick = async () => {
      const path = current.current.root;
      if (!active || running || !path) return;
      running = true;
      try {
        const config = await backupApi.config();
        if (!active || !due(config)) return;
        const bundle = await current.current.getBundle();
        if (!active || path !== current.current.root) return;
        // A user may disable scheduling, change the destination, or complete a
        // manual backup while bundle collection is awaiting persistence.
        const latest = await backupApi.config();
        if (
          !active ||
          path !== current.current.root ||
          !due(latest) ||
          latest.destination !== config.destination
        )
          return;
        const snapshot = await backupApi.create(path, bundle, true);
        lastError = '';
        if (active)
          current.current.onNotify(
            current.current.language === 'en'
              ? `Scheduled backup complete: ${snapshot.fileCount} files.`
              : `定期备份完成：${snapshot.fileCount} 个文件。`,
          );
      } catch (reason) {
        const message = describeError(reason);
        if (message.startsWith('BACKUP_NOT_DUE:')) return;
        if (active && message !== lastError) {
          lastError = message;
          current.current.onNotify(
            current.current.language === 'en'
              ? `Scheduled backup failed: ${message}`
              : `定期备份失败：${message}`,
            true,
          );
        }
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  return null;
}
