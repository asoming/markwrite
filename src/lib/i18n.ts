import { useSyncExternalStore } from 'react';
import english from './i18n.en';
export type Language = 'zh-CN' | 'en';
let language: Language = 'zh-CN';
const listeners = new Set<() => void>();
export function getLanguage(): Language {
  return language;
}
export function setLanguage(next: Language) {
  if (next !== 'en' && next !== 'zh-CN') return;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (language === next) return;
  language = next;
  for (const listener of listeners) listener();
}
/** Keys are interface text only. Document content and paths belong in interpolation values. */
export function t(key: string, fallback?: string, values?: readonly unknown[]): string {
  const translated = language === 'en' ? (english[key] ?? fallback ?? key) : key;
  return values
    ? translated.replace(/\{(\d+)\}/g, (match, index: string) =>
        Number(index) < values.length ? String(values[Number(index)] ?? '') : match,
      )
    : translated;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useI18n() {
  const current = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  return { language: current, t, setLanguage };
}
