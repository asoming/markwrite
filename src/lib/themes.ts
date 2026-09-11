import type { Theme } from './types';
import './themes.css';

export type ThemeOption = {
  id: Theme;
  name: { 'zh-CN': string; en: string };
  description: { 'zh-CN': string; en: string };
  paper: string;
  ink: string;
  accent: string;
  serif: boolean;
};

// Original presets. Names identify familiar reading styles; no third-party theme assets are used.
export const themeOptions: readonly ThemeOption[] = [
  {
    id: 'system',
    name: { 'zh-CN': '跟随系统', en: 'System' },
    description: { 'zh-CN': '随系统切换明暗', en: 'Match your system appearance' },
    paper: '#fcfcfd',
    ink: '#24272e',
    accent: '#4361d9',
    serif: false,
  },
  {
    id: 'light',
    name: { 'zh-CN': '浅色', en: 'Light' },
    description: { 'zh-CN': '墨页默认浅色', en: 'The default light palette' },
    paper: '#fcfcfd',
    ink: '#24272e',
    accent: '#4361d9',
    serif: false,
  },
  {
    id: 'dark',
    name: { 'zh-CN': '深色', en: 'Dark' },
    description: { 'zh-CN': '墨页默认深色', en: 'The default dark palette' },
    paper: '#20232a',
    ink: '#e1e5ec',
    accent: '#93a8ff',
    serif: false,
  },
  {
    id: 'github',
    name: { 'zh-CN': 'Github', en: 'Github' },
    description: { 'zh-CN': '清晰标题与蓝色链接', en: 'Clear headings, blue links' },
    paper: '#ffffff',
    ink: '#24292f',
    accent: '#0969da',
    serif: false,
  },
  {
    id: 'newsprint',
    name: { 'zh-CN': 'Newsprint', en: 'Newsprint' },
    description: { 'zh-CN': '纸张底色与衬线正文', en: 'Paper tones, serif text' },
    paper: '#f4f0e6',
    ink: '#37332d',
    accent: '#88643c',
    serif: true,
  },
  {
    id: 'night',
    name: { 'zh-CN': 'Night', en: 'Night' },
    description: { 'zh-CN': '深蓝底色与柔和文字', en: 'Deep blue, soft contrast' },
    paper: '#18212b',
    ink: '#dce5ee',
    accent: '#8ecbdf',
    serif: false,
  },
  {
    id: 'pixyll',
    name: { 'zh-CN': 'Pixyll', en: 'Pixyll' },
    description: { 'zh-CN': '衬线正文与醒目标题', en: 'Serif text, distinct headings' },
    paper: '#fefdfb',
    ink: '#35343b',
    accent: '#82629a',
    serif: true,
  },
  {
    id: 'whitey',
    name: { 'zh-CN': 'Whitey', en: 'Whitey' },
    description: { 'zh-CN': '中性白底与细线分隔', en: 'Neutral white, fine rules' },
    paper: '#ffffff',
    ink: '#3d4447',
    accent: '#337d78',
    serif: false,
  },
];

export function isTheme(value: unknown): value is Theme {
  return themeOptions.some((theme) => theme.id === value);
}
export function resolveTheme(theme: Theme, systemDark: boolean): Exclude<Theme, 'system'> {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}
export function themeIsDark(theme: Theme, systemDark = false) {
  const resolved = resolveTheme(theme, systemDark);
  return resolved === 'dark' || resolved === 'night';
}
export function themeTypography(theme: Theme) {
  const serif = themeOptions.find((option) => option.id === theme)?.serif || false;
  return {
    serif,
    bodyFont: serif
      ? '"Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif'
      : '"Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif',
    codeFont: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
  };
}
