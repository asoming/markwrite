import type { Theme } from './types';
import './themes.css';
import './themeFonts.css';

export type ThemeOption = {
  id: Theme;
  name: { 'zh-CN': string; en: string };
  description: { 'zh-CN': string; en: string };
  paper: string;
  ink: string;
  accent: string;
  serif: boolean;
};

// Typography follows the themes linked by theme.typora.io; see public/themes/NOTICE.txt.
// Pixyll is MIT-derived. The other four adapters are independently written for our DOM.
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
    description: { 'zh-CN': 'Markwrite 默认浅色', en: 'The default light palette' },
    paper: '#fcfcfd',
    ink: '#24272e',
    accent: '#4361d9',
    serif: false,
  },
  {
    id: 'dark',
    name: { 'zh-CN': '深色', en: 'Dark' },
    description: { 'zh-CN': 'Markwrite 默认深色', en: 'The default dark palette' },
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
    ink: '#333333',
    accent: '#4183c4',
    serif: false,
  },
  {
    id: 'newsprint',
    name: { 'zh-CN': 'Newsprint', en: 'Newsprint' },
    description: { 'zh-CN': '纸张底色与衬线正文', en: 'Paper tones, serif text' },
    paper: '#f3f2ee',
    ink: '#1f0909',
    accent: '#065588',
    serif: true,
  },
  {
    id: 'night',
    name: { 'zh-CN': 'Night', en: 'Night' },
    description: { 'zh-CN': '石墨灰底色与紧凑标题', en: 'Graphite paper, compact headings' },
    paper: '#363b40',
    ink: '#b8bfc6',
    accent: '#6dc1e7',
    serif: false,
  },
  {
    id: 'pixyll',
    name: { 'zh-CN': 'Pixyll', en: 'Pixyll' },
    description: {
      'zh-CN': 'Merriweather 正文与 Lato 大标题',
      en: 'Merriweather text, large Lato headings',
    },
    paper: '#ffffff',
    ink: '#333333',
    accent: '#463f5c',
    serif: true,
  },
  {
    id: 'whitey',
    name: { 'zh-CN': 'Whitey', en: 'Whitey' },
    description: { 'zh-CN': 'Vollkorn 衬线与居中标题', en: 'Vollkorn serif, centered headings' },
    paper: '#fefefe',
    ink: '#333333',
    accent: '#2484c1',
    serif: true,
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
export type ThemeMetrics = { fontSize: number; lineHeight: number; width: number; serif: boolean };

/** Applied when selecting a preset; subsequent user adjustments remain ordinary settings. */
export function themeDefaults(theme: Theme): ThemeMetrics {
  const metrics: Partial<Record<Theme, Omit<ThemeMetrics, 'serif'>>> = {
    github: { fontSize: 16, lineHeight: 1.6, width: 860 },
    newsprint: { fontSize: 16, lineHeight: 1.5, width: 640 },
    night: { fontSize: 16, lineHeight: 1.625, width: 914 },
    pixyll: { fontSize: 20, lineHeight: 1.8, width: 914 },
    whitey: { fontSize: 19, lineHeight: 1.53, width: 960 },
  };
  return {
    ...(metrics[theme] || { fontSize: 17, lineHeight: 1.9, width: 760 }),
    serif: themeOptions.find((option) => option.id === theme)?.serif || false,
  };
}

export function themeTypography(theme: Theme) {
  const serif = themeDefaults(theme).serif;
  const cjkSerif = '\"Noto Serif CJK SC\", \"Source Han Serif SC\", SimSun, serif';
  const cjkSans = '\"Noto Sans CJK SC\", \"Source Han Sans SC\", system-ui, sans-serif';
  const bodyFonts: Partial<Record<Theme, string>> = {
    github:
      '\"Markwrite Open Sans\", \"Open Sans\", \"Helvetica Neue\", Helvetica, Arial, ' + cjkSans,
    newsprint: '\"Markwrite PT Serif\", \"PT Serif\", \"Times New Roman\", ' + cjkSerif,
    night: '\"Helvetica Neue\", Helvetica, Arial, ' + cjkSans,
    pixyll: '\"Markwrite Merriweather\", Merriweather, \"PT Serif\", Georgia, ' + cjkSerif,
    whitey: '\"Markwrite Vollkorn\", Vollkorn, Palatino, \"Times New Roman\", ' + cjkSerif,
  };
  return {
    serif,
    bodyFont: bodyFonts[theme] || (serif ? cjkSerif : cjkSans),
    codeFont:
      theme === 'night'
        ? 'Monaco, Consolas, \"Andale Mono\", \"DejaVu Sans Mono\", monospace'
        : 'Consolas, Menlo, Monaco, \"DejaVu Sans Mono\", monospace',
  };
}
