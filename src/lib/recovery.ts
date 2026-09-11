import type { Document, Settings } from './types';
const KEY = 'markwrite.session.v1';
export const defaultSettings: Settings = {
  theme: 'system',
  fontSize: 17,
  lineHeight: 1.9,
  width: 760,
  autosave: true,
  serif: false,
};
export function readSession(): {
  docs: Document[];
  active: string;
  settings: Settings;
  root?: string;
} | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (
      !value ||
      !Array.isArray(value.docs) ||
      !value.docs.every((d: Document) => typeof d.content === 'string' && typeof d.id === 'string')
    )
      return null;
    return {
      ...value,
      settings: { ...defaultSettings, ...value.settings },
      docs: value.docs.map((d: Document) => ({
        ...d,
        status: d.content === d.saved ? 'clean' : 'dirty',
      })),
    };
  } catch {
    return null;
  }
}
export function writeSession(docs: Document[], active: string, settings: Settings, root?: string) {
  // Throws on quota or storage failure; callers must surface it, never report success.
  localStorage.setItem(KEY, JSON.stringify({ docs, active, settings, root }));
}
