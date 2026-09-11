import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupConfig, BackupInspection, BackupSummary } from '../src/lib/backup';

const api = vi.hoisted(() => ({
  available: vi.fn(),
  config: vi.fn(),
  list: vi.fn(),
  chooseDestination: vi.fn(),
  schedule: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  chooseSnapshot: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('../src/lib/backup', async (original) => ({
  ...(await original<typeof import('../src/lib/backup')>()),
  backupApi: api,
}));
import BackupPanel, { BackupScheduler, type BackupPanelProps } from '../src/components/BackupPanel';

const initialConfig: BackupConfig = {
  destination: null,
  enabled: false,
  intervalHours: 24,
  lastBackupAtMs: null,
  nextBackupAtMs: null,
  lastError: null,
};
const summary: BackupSummary = {
  id: 'snapshot-1',
  path: '/backups/snapshot-1',
  workspaceName: 'Notes',
  createdAtMs: 1_800_000_000_000,
  fileCount: 3,
  markdownCount: 2,
  imageCount: 1,
  totalBytes: 8192,
  settingsIncluded: true,
  skippedFiles: 1,
};
const inspection: BackupInspection = {
  summary,
  files: [{ path: '文件.md', size: 64, sha256: 'abc' }],
  settingsBundle: { settings: { theme: 'night' } },
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(api)) fn.mockReset();
  api.available.mockReturnValue(true);
  api.config.mockResolvedValue({ ...initialConfig });
  api.list.mockResolvedValue([]);
  api.inspect.mockResolvedValue(inspection);
  api.create.mockResolvedValue(summary);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});
async function render(props: Partial<BackupPanelProps> = {}) {
  const getBundle = vi.fn(async () => ({ settings: { theme: 'night' }, customThemes: [] }));
  const onRestored = vi.fn(async () => {});
  await act(async () =>
    root.render(createElement(BackupPanel, { language: 'en', getBundle, onRestored, ...props })),
  );
  return { getBundle, onRestored };
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => (node.getAttribute('aria-label') || node.textContent?.trim()) === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const click = async (label: string) => {
  await act(async () => button(label).click());
};
async function toggle(label: string) {
  await act(async () =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.click(),
  );
}

describe('backup preferences', () => {
  it('starts with backup off, requires an open folder and destination, and never writes backup preferences into localStorage', async () => {
    const { getBundle } = await render();
    expect(host.textContent).toContain('Open a folder first');
    expect(button('Back up now').disabled).toBe(true);
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Enable scheduled backups"]')!.checked,
    ).toBe(false);
    expect(api.config).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.schedule).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('treats directory-picker cancellation as no change and performs manual backup only on the explicit action', async () => {
    const state = await render({ root: '/notes' });
    api.chooseDestination.mockResolvedValueOnce(null);
    await click('Choose location');
    expect(button('Back up now').disabled).toBe(true);
    const configured = { ...initialConfig, destination: '/backups' };
    api.chooseDestination.mockResolvedValueOnce(configured);
    api.config.mockResolvedValue(configured);
    await click('Choose location');
    expect(api.create).not.toHaveBeenCalled();
    expect(button('Back up now').disabled).toBe(false);
    api.list.mockResolvedValueOnce([summary]);
    await click('Back up now');
    expect(state.getBundle).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith('/notes', {
      settings: { theme: 'night' },
      customThemes: [],
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Backup complete: 3 files, 8.0 KB',
    );
    expect(host.textContent).toContain('2 Markdown · 1 images');
    expect(api.schedule).not.toHaveBeenCalled();
  });

  it('does not optimistically enable a failed schedule update and displays the confirmed next due date', async () => {
    api.config.mockResolvedValue({ ...initialConfig, destination: '/backups' });
    await render({ root: '/notes', language: 'zh-CN' });
    api.schedule.mockRejectedValueOnce(new Error('配置保存失败'));
    await toggle('启用定期备份');
    expect(host.querySelector<HTMLInputElement>('input[aria-label="启用定期备份"]')!.checked).toBe(
      false,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('配置保存失败');
    api.schedule.mockResolvedValueOnce({
      ...initialConfig,
      destination: '/backups',
      enabled: true,
      nextBackupAtMs: summary.createdAtMs,
    });
    await toggle('启用定期备份');
    expect(api.schedule).toHaveBeenLastCalledWith(true, 24);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="启用定期备份"]')!.checked).toBe(
      true,
    );
    expect(host.textContent).toContain(new Date(summary.createdAtMs).toLocaleString('zh-CN'));
    expect(api.create).not.toHaveBeenCalled();
  });

  it('keeps a failed manual backup visible as failure without a success message', async () => {
    api.config.mockResolvedValue({ ...initialConfig, destination: '/backups' });
    api.list.mockResolvedValue([summary]);
    api.create.mockRejectedValueOnce(new Error('Disk full'));
    await render({ root: '/notes' });
    await click('Back up now');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Disk full');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(button('Preview restore snapshot-1')).toBeDefined();
  });

  it('reviews a snapshot before selecting a new restore location and optionally restores files without preferences', async () => {
    api.list.mockResolvedValue([summary]);
    const { onRestored } = await render();
    await click('Preview restore snapshot-1');
    expect(api.inspect).toHaveBeenCalledWith(summary.path);
    expect(api.restore).not.toHaveBeenCalled();
    expect(host.textContent).toContain('existing documents will not be overwritten');
    expect(host.textContent).toContain('文件.md');
    await toggle('Also restore app preferences');
    api.restore.mockResolvedValueOnce(null);
    await click('Choose location and restore');
    expect(onRestored).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="Review before restoring"]')).not.toBeNull();
    const result = {
      path: '/new/Markwrite-restored-1',
      settingsBundle: inspection.settingsBundle,
      fileCount: 3,
      totalBytes: 8192,
    };
    api.restore.mockResolvedValueOnce(result);
    await click('Choose location and restore');
    expect(api.restore).toHaveBeenCalledWith(summary.path);
    expect(onRestored).toHaveBeenCalledWith({ ...result, settingsBundle: null });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Snapshot restored to a new folder',
    );
    expect(host.textContent).toContain(result.path);
  });

  it('distinguishes restored files from a later failure to apply preferences', async () => {
    api.chooseSnapshot.mockResolvedValueOnce(inspection);
    api.restore.mockResolvedValueOnce({
      path: '/new/Markwrite-restored-2',
      settingsBundle: inspection.settingsBundle,
      fileCount: 3,
      totalBytes: 8192,
    });
    const onRestored = vi.fn(async () => {
      throw new Error('Preferences are invalid');
    });
    await render({ onRestored });
    await click('Restore from another location…');
    await click('Choose location and restore');
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Files were restored');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).toContain('/new/Markwrite-restored-2');
  });

  it('does not invoke native commands in the browser preview', async () => {
    api.available.mockReturnValue(false);
    await render();
    expect(host.textContent).toContain('available in the desktop app');
    expect(api.config).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
  });
});

describe('backup scheduler', () => {
  async function scheduler(
    path: string | undefined = '/notes',
    getBundle = vi.fn(async (): Promise<unknown> => ({ settings: {} })),
  ) {
    const onNotify = vi.fn();
    await act(async () =>
      root.render(
        createElement(BackupScheduler, { root: path, getBundle, onNotify, language: 'en' }),
      ),
    );
    return { getBundle, onNotify };
  }
  it('never collects settings or creates snapshots when disabled or no folder is open', async () => {
    vi.useFakeTimers();
    const { getBundle } = await scheduler();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(api.config).toHaveBeenCalledTimes(3);
    expect(getBundle).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        createElement(BackupScheduler, { root: undefined, getBundle, onNotify: vi.fn() }),
      ),
    );
    api.config.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(api.config).not.toHaveBeenCalled();
  });
  it('backs up an overdue schedule once and checks again only after a minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(summary.createdAtMs);
    let config = {
      ...initialConfig,
      destination: '/backups',
      enabled: true,
      nextBackupAtMs: Date.now() - 1,
    };
    api.config.mockImplementation(async () => config);
    api.create.mockImplementation(async () => {
      config = { ...config, nextBackupAtMs: Date.now() + 3_600_000 };
      return summary;
    });
    const { getBundle, onNotify } = await scheduler();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(getBundle).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith('/notes', { settings: {} }, true);
    expect(onNotify).toHaveBeenCalledWith('Scheduled backup complete: 3 files.');
    const calls = api.config.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(api.config).toHaveBeenCalledTimes(calls);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.config).toHaveBeenCalledTimes(calls + 1);
    expect(api.create).toHaveBeenCalledTimes(1);
  });
  it('rechecks scheduling after awaiting settings and respects a user disabling it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(summary.createdAtMs);
    api.config.mockResolvedValue({
      ...initialConfig,
      destination: '/backups',
      enabled: true,
      nextBackupAtMs: Date.now() - 1,
    });
    let finish!: (value: unknown) => void;
    const getBundle = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    await scheduler('/notes', getBundle);
    api.config.mockResolvedValue({ ...initialConfig, destination: '/backups' });
    await act(async () => finish({ settings: {} }));
    expect(api.create).not.toHaveBeenCalled();
  });
  it('reports a failed scheduled backup without a success notification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(summary.createdAtMs);
    api.config.mockResolvedValue({
      ...initialConfig,
      destination: '/backups',
      enabled: true,
      nextBackupAtMs: Date.now() - 1,
    });
    api.create.mockRejectedValueOnce(new Error('Disk unavailable'));
    const { onNotify } = await scheduler();
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith('Scheduled backup failed: Disk unavailable', true);
  });
  it('silently skips a schedule that another window has already completed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(summary.createdAtMs);
    api.config.mockResolvedValue({
      ...initialConfig,
      destination: '/backups',
      enabled: true,
      nextBackupAtMs: Date.now() - 1,
    });
    api.create.mockRejectedValueOnce('BACKUP_NOT_DUE: another window completed this backup');
    const { onNotify } = await scheduler();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(onNotify).not.toHaveBeenCalled();
  });
});
