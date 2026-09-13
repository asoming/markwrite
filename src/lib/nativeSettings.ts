import { invoke, isTauri } from '@tauri-apps/api/core';
export type ImportSource = {
  path: string;
  name: string;
  extension: 'txt' | 'html' | 'htm' | 'docx';
  bytes: number[];
};
export type MarkdownDefaultStatus = {
  platform: 'linux' | 'windows' | 'macos' | 'other';
  isDefault: boolean | null;
  handlers: { type: string; application: string }[];
  canRequest: boolean;
  message: string;
};
export async function chooseImportFiles(): Promise<ImportSource[]> {
  if (!isTauri()) throw new Error('请选择浏览器文件输入，或在桌面版导入本地文档。');
  return invoke('choose_import_files');
}
export async function defaultMarkdownStatus(): Promise<MarkdownDefaultStatus> {
  if (!isTauri())
    return {
      platform: 'other',
      isDefault: null,
      handlers: [],
      canRequest: false,
      message: '默认应用关联仅能在桌面版设置。',
    };
  return invoke('default_markdown_status');
}
/** Call only from the user's explicit settings-button action, never during startup/status refresh. */
export async function requestMarkdownDefault(): Promise<MarkdownDefaultStatus> {
  if (!isTauri()) throw new Error('请在桌面版设置默认 Markdown 应用。');
  return invoke('request_markdown_default');
}
