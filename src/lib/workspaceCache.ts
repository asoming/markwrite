import { invoke } from '@tauri-apps/api/core';
import type { DiskFile } from './types';
let cached:
  { root: string; version: number; files?: DiskFile[]; request?: Promise<DiskFile[]> } | undefined;
let version = 0;
export function invalidateWorkspaceIndex() {
  version++;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('markwrite-index-invalidated'));
}
export function workspaceDocuments(root: string, force = false): Promise<DiskFile[]> {
  if (force) version++;
  if (cached?.root === root && cached.version === version) {
    if (cached.files) return Promise.resolve(cached.files);
    if (cached.request) return cached.request;
  }
  const entry = { root, version } as NonNullable<typeof cached>;
  cached = entry;
  entry.request = invoke<DiskFile[]>('workspace_documents', { path: root }).then(
    (files) => {
      entry.files = files;
      entry.request = undefined;
      return files;
    },
    (error) => {
      if (cached === entry) cached = undefined;
      throw error;
    },
  );
  return entry.request;
}
