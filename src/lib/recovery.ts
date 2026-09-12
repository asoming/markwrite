import type { DiskFile, Document, Settings } from './types';
import { isTheme, themeDefaults } from './themes';
import { invoke, isTauri } from '@tauri-apps/api/core';
const KEY = 'markwrite.session.v1';
let nativeSession: string | null = null;
let lastPersisted = '';
let flushQueue: Promise<void> = Promise.resolve();
let serialized:
  { docs: Document[]; active: string; settings: Settings; root?: string; json: string } | undefined;
const PREFS = 'markwrite.preferences.v1';
export type Session = { docs: Document[]; active: string; settings: Settings; root?: string };
let deferred = false;
let openError = '';
export const initialOpenError = () => openError;
let deferredRead: Promise<Session | null> | undefined;
export const recoveryPending = () => deferred;
export async function prepareSession() {
  if (!isTauri()) return;
  const [initial, context] = await Promise.all([
    invoke<DiskFile[]>('initial_documents').catch((error) => {
      openError = String(error);
      return [];
    }),
    invoke<{ settings?: Settings }>('window_context'),
  ]);
  if (initial.length) {
    let preferences: Partial<Settings> = context.settings || {};
    try {
      preferences = context.settings || JSON.parse(localStorage.getItem(PREFS) || '{}');
    } catch {
      /* old preferences recovered after first paint */
    }
    const docs: Document[] = initial.map((file) => ({
      ...file,
      id: crypto.randomUUID(),
      name: file.path.replace(/\\/g, '/').split('/').pop()!,
      saved: file.content,
      updated: Date.now(),
      status: 'clean',
    }));
    nativeSession = JSON.stringify({
      docs,
      active: docs[0].id,
      settings: { ...defaultSettings, ...preferences },
    });
    deferred = true;
  } else {
    nativeSession = (await invoke<string | null>('load_session')) || localStorage.getItem(KEY);
    if (!nativeSession && context.settings)
      nativeSession = JSON.stringify({
        docs: [],
        active: '',
        settings: { ...defaultSettings, ...context.settings },
      });
  }
}
/** Read old buffers after the requested file has painted. Until merged, writes stay blocked. */
export function loadDeferredSession(): Promise<Session | null> {
  if (!deferred) return Promise.resolve(null);
  return (deferredRead ||= invoke<string | null>('load_session')
    .then((json) => parseSession(json || localStorage.getItem(KEY)))
    .catch((error) => {
      deferredRead = undefined;
      throw error;
    }));
}
export function finishRecovery() {
  deferred = false;
}
export function mergeRecoveredDocuments(opened: Document[], previous: Document[]): Document[] {
  const merged = [...opened];
  for (const doc of previous) {
    if (merged.some((item) => item.id === doc.id)) continue;
    const same = doc.path && opened.find((item) => item.path === doc.path);
    if (same && doc.content === doc.saved) continue;
    // A recovered unsaved buffer gets its own tab. Never replace the requested disk view.
    merged.push(
      same ? { ...doc, status: same.version === doc.version ? doc.status : 'conflict' } : doc,
    );
  }
  return merged;
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
  markdownCompatibility: false,
};
export function readSession(): Session | null {
  return parseSession(isTauri() ? nativeSession : localStorage.getItem(KEY));
}
export function parseSession(json: string | null): Session | null {
  try {
    const value = JSON.parse(json || 'null');
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
        markdownCompatibility: value.settings?.markdownCompatibility === true,
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
  if (deferred) throw new Error('Recovery is still being read; the existing session is preserved.');
  // Throws on quota or storage failure; callers must surface it, never report success.
  const unchanged =
    serialized?.docs === docs &&
    serialized.active === active &&
    serialized.settings === settings &&
    serialized.root === root;
  const json = unchanged ? serialized!.json : JSON.stringify({ docs, active, settings, root });
  if (isTauri()) nativeSession = json;
  else localStorage.setItem(KEY, json);
  serialized = { docs, active, settings, root, json };
  try {
    localStorage.setItem(PREFS, JSON.stringify(settings));
  } catch {
    /* The full durable session remains authoritative. */
  }
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
