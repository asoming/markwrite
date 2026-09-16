import { validShortcuts } from './shortcuts';
import type { DiskFile, Document, Settings } from './types';
import { isTheme, themeDefaults } from './themes';
import { invoke, isTauri } from '@tauri-apps/api/core';
const KEY = 'markwrite.session.v1';
let nativeSession: string | null = null;
let lastPersisted = '';
let flushQueue: Promise<void> = Promise.resolve();
let discarded: { snapshot: Document[]; docs: Document[]; active: string } | undefined;
let serialized:
  { docs: Document[]; active: string; settings: Settings; root?: string; json: string } | undefined;
const PREFS = 'markwrite.preferences.v1';
export type Session = {
  docs: Document[];
  active: string;
  settings: Settings;
  root?: string;
  pendingDocs?: Document[];
};
let pendingDocs: Document[] = [];
export const pendingDrafts = () => pendingDocs;
export function forgetPendingDraft(id: string) {
  pendingDocs = pendingDocs.filter((doc) => doc.id !== id);
  serialized = undefined;
}
/** Keep unsaved work separately; a new launch never restores old tabs or folders. */
export function archiveSession(previous: Session | null) {
  pendingDocs = [
    ...new Map(
      [...(previous?.pendingDocs || []), ...(previous?.docs || [])]
        .filter(
          (doc) => doc.content !== doc.saved || doc.status === 'conflict' || doc.status === 'error',
        )
        .map((doc) => [doc.id, doc]),
    ).values(),
  ];
  serialized = undefined;
}
let deferred = false;
let openError = '';
export const initialOpenError = () => openError;
let deferredRead: Promise<Session | null> | undefined;
export const recoveryPending = () => deferred;
export async function prepareSession() {
  deferredRead = undefined;
  if (!isTauri()) {
    const previous = parseSession(localStorage.getItem(KEY));
    archiveSession(previous);
    localStorage.setItem(
      KEY,
      JSON.stringify({
        docs: [],
        active: '',
        settings: previous?.settings || defaultSettings,
        pendingDocs,
      }),
    );
    return;
  }
  const [initial, context] = await Promise.all([
    invoke<DiskFile[]>('initial_documents').catch((error) => {
      openError = String(error);
      return [];
    }),
    invoke<{ settings?: Settings; restore?: boolean }>('window_context'),
  ]);
  if (initial.length) {
    let preferences: Partial<Settings> = context.settings || {};
    try {
      preferences = JSON.parse(localStorage.getItem(PREFS) || 'null') || context.settings || {};
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
    const previous = parseSession(
      (await invoke<string | null>('load_session')) || localStorage.getItem(KEY),
    );
    if (context.restore && previous) {
      // Only the explicit Restore independent window command requests old tabs.
      pendingDocs = previous.pendingDocs || [];
      nativeSession = JSON.stringify(previous);
      return;
    }
    archiveSession(previous);
    nativeSession = JSON.stringify({
      docs: [],
      active: '',
      pendingDocs,
      settings: previous?.settings || context.settings || defaultSettings,
    });
  }
}
/** Read the recovery archive after first paint. Until archived, writes stay blocked. */
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
  shortcuts: {},
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
  markdownProfile: 'technical',
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
        shortcuts: validShortcuts(value.settings?.shortcuts),
        markdownCompatibility: value.settings?.markdownCompatibility === true,
        markdownProfile: ['technical', 'github', 'commonmark'].includes(
          value.settings?.markdownProfile || '',
        )
          ? value.settings!.markdownProfile
          : 'technical',
        floatingToolbarTransparency:
          typeof value.settings?.floatingToolbarTransparency === 'number' &&
          Number.isFinite(value.settings.floatingToolbarTransparency)
            ? Math.min(80, Math.max(0, value.settings.floatingToolbarTransparency))
            : defaultSettings.floatingToolbarTransparency,
        defaultMode: ['read', 'live', 'source'].includes(value.settings?.defaultMode)
          ? value.settings.defaultMode
          : defaultSettings.defaultMode,
      },
      pendingDocs: Array.isArray(value.pendingDocs)
        ? value.pendingDocs.filter(
            (d: Document) => typeof d?.content === 'string' && typeof d?.id === 'string',
          )
        : [],
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
  // Timers and beforeunload may still hold the buffers explicitly discarded for exit.
  // Keep their clean replacement authoritative until a genuinely new edit occurs.
  if (discarded?.snapshot === docs) {
    docs = discarded.docs;
    active = discarded.active;
  }
  // Throws on quota or storage failure; callers must surface it, never report success.
  const unchanged =
    serialized?.docs === docs &&
    serialized.active === active &&
    serialized.settings === settings &&
    serialized.root === root;
  const json = unchanged
    ? serialized!.json
    : JSON.stringify({ docs, active, settings, root, pendingDocs });
  if (isTauri()) nativeSession = json;
  else localStorage.setItem(KEY, json);
  serialized = { docs, active, settings, root, json };
  try {
    localStorage.setItem(PREFS, JSON.stringify(settings));
  } catch {
    /* The full durable session remains authoritative. */
  }
}

export const isDiscardedSession = (docs: Document[]) => discarded?.snapshot === docs;

export function cancelDiscardSession() {
  discarded = undefined;
  serialized = undefined;
  lastPersisted = '';
}

/** Forget unsaved buffers in both recovery generations without writing source files. */
export async function discardSessionChanges(
  snapshot: Document[],
  active: string,
  settings: Settings,
  root?: string,
) {
  const docs: Document[] = snapshot
    .filter((doc) => doc.path)
    .map((doc) => ({
      ...doc,
      content: doc.saved,
      status: 'clean',
      error: undefined,
    }));
  discarded = {
    snapshot,
    docs,
    active: docs.some((doc) => doc.id === active) ? active : docs[0]?.id || '',
  };
  try {
    writeSession(snapshot, active, settings, root);
    if (!isTauri()) return;
    const json = nativeSession!;
    flushQueue = flushQueue
      .catch(() => {})
      .then(async () => {
        await invoke('save_session', { json, discardPrevious: true });
        lastPersisted = json;
      });
    await flushQueue;
    // Older desktop versions used localStorage as a fallback recovery source.
    localStorage.removeItem(KEY);
  } catch (error) {
    cancelDiscardSession();
    throw error;
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
