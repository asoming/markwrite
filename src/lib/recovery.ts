import type { Document, Settings } from './types';
import { isTheme, themeDefaults } from './themes';
import { invoke, isTauri } from '@tauri-apps/api/core';
const KEY = 'markwrite.session.v1';
let nativeSession: string | null = null;
let lastPersisted = '';
let flushQueue: Promise<void> = Promise.resolve();
export async function prepareSession() {
  if (isTauri())
    nativeSession = (await invoke<string | null>('load_session')) || localStorage.getItem(KEY);
}
export const defaultSettings: Settings = {
  theme: 'system',
  language: 'zh-CN',
  defaultMode: 'read',
  followFileParent: true,
  floatingToolbarTransparency: 15,
  fontSize: 17,
  lineHeight: 1.9,
  width: 760,
  autosave: true,
  serif: false,
  bodyFont: '',
  codeFont: '',
  attachmentMode: 'relative',
};
export function readSession(): {
  docs: Document[];
  active: string;
  settings: Settings;
  root?: string;
} | null {
  try {
    const value = JSON.parse((isTauri() ? nativeSession : localStorage.getItem(KEY)) || 'null');
    if (
      !value ||
      !Array.isArray(value.docs) ||
      !value.docs.every((d: Document) => typeof d.content === 'string' && typeof d.id === 'string')
    )
      return null;
    return {
      ...value,
      settings: {
        ...defaultSettings,
        ...value.settings,
        ...(['github', 'newsprint', 'night', 'pixyll', 'whitey'].includes(value.settings?.theme) &&
        value.settings.fontSize === 17 &&
        value.settings.lineHeight === 1.9 &&
        value.settings.width === 760
          ? themeDefaults(value.settings.theme)
          : {}),
        codeFont:
          value.settings?.codeFont === '"Cascadia Code", "JetBrains Mono", Consolas, monospace'
            ? ''
            : value.settings?.codeFont || '',
        theme: isTheme(value.settings?.theme) ? value.settings.theme : defaultSettings.theme,
        language: value.settings?.language === 'en' ? 'en' : 'zh-CN',
        followFileParent: value.settings?.followFileParent !== false,
        floatingToolbarTransparency:
          typeof value.settings?.floatingToolbarTransparency === 'number' &&
          Number.isFinite(value.settings.floatingToolbarTransparency)
            ? Math.min(80, Math.max(0, value.settings.floatingToolbarTransparency))
            : defaultSettings.floatingToolbarTransparency,
        defaultMode: ['read', 'live', 'source'].includes(value.settings?.defaultMode)
          ? value.settings.defaultMode
          : defaultSettings.defaultMode,
      },
      docs: value.docs.map((d: Document) => ({
        ...d,
        status:
          d.status === 'conflict'
            ? 'conflict'
            : d.status === 'error'
              ? 'error'
              : d.content === d.saved
                ? 'clean'
                : 'dirty',
      })),
    };
  } catch {
    return null;
  }
}
export function writeSession(docs: Document[], active: string, settings: Settings, root?: string) {
  // Throws on quota or storage failure; callers must surface it, never report success.
  const json = JSON.stringify({ docs, active, settings, root });
  if (isTauri()) nativeSession = json;
  else localStorage.setItem(KEY, json);
}
export async function flushSession(
  docs: Document[],
  active: string,
  settings: Settings,
  root?: string,
) {
  writeSession(docs, active, settings, root);
  if (!isTauri()) return;
  const json = nativeSession!;
  flushQueue = flushQueue
    .catch(() => {})
    .then(async () => {
      if (lastPersisted === json) return;
      await invoke('save_session', { json });
      lastPersisted = json;
    });
  return flushQueue;
}
