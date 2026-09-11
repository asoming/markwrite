import { invoke, isTauri } from '@tauri-apps/api/core';

export type BackupConfig = {
  destination: string | null;
  enabled: boolean;
  intervalHours: number;
  lastBackupAtMs: number | null;
  nextBackupAtMs: number | null;
  lastError: string | null;
};
export type BackupSummary = {
  id: string;
  path: string;
  workspaceName: string;
  createdAtMs: number;
  fileCount: number;
  markdownCount: number;
  imageCount: number;
  totalBytes: number;
  settingsIncluded: boolean;
  skippedFiles: number;
};
export type BackupInspection = {
  summary: BackupSummary;
  files: { path: string; size: number; sha256: string }[];
  settingsBundle: unknown;
};
export type BackupRestored = {
  path: string;
  settingsBundle: unknown;
  fileCount: number;
  totalBytes: number;
};
export const backupChangedEvent = 'markwrite-backups-changed';
const changed = () => window.dispatchEvent(new Event(backupChangedEvent));
export const backupApi = {
  available: () => isTauri(),
  config: () => invoke<BackupConfig>('backup_config'),
  list: () => invoke<BackupSummary[]>('backup_list'),
  async chooseDestination() {
    const config = await invoke<BackupConfig | null>('backup_pick_destination');
    if (config) changed();
    return config;
  },
  async schedule(enabled: boolean, intervalHours: number) {
    const config = await invoke<BackupConfig>('backup_update_schedule', { enabled, intervalHours });
    changed();
    return config;
  },
  async create(path: string, settingsBundle: unknown, automatic = false) {
    try {
      return await invoke<BackupSummary>('backup_create', { path, settingsBundle, automatic });
    } finally {
      changed();
    }
  },
  inspect: (snapshot: string) => invoke<BackupInspection>('backup_inspect', { snapshot }),
  chooseSnapshot: () => invoke<BackupInspection | null>('backup_pick_snapshot'),
  restore: (snapshot: string) => invoke<BackupRestored | null>('backup_restore', { snapshot }),
};

export function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
