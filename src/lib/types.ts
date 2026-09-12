export type Mode = 'live' | 'source' | 'read';
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'gbk';
export type Language = 'zh-CN' | 'en';
export type Theme =
  'light' | 'dark' | 'system' | 'github' | 'newsprint' | 'night' | 'pixyll' | 'whitey';
export type FileEntry = { name: string; path: string; directory: boolean; children?: FileEntry[] };
export type DiskFile = {
  encoding?: TextEncoding;
  path: string;
  content: string;
  version: string;
  bom: boolean;
  crlf: boolean;
};
export type Document = {
  encoding?: TextEncoding;
  id: string;
  name: string;
  path?: string;
  content: string;
  saved: string;
  version?: string;
  bom: boolean;
  crlf: boolean;
  updated: number;
  status: 'clean' | 'dirty' | 'saving' | 'error' | 'conflict';
  error?: string;
};
export type Settings = {
  theme: Theme;
  language: Language;
  defaultMode: Mode;
  followFileParent: boolean;
  floatingToolbarTransparency: number;
  fontSize: number;
  lineHeight: number;
  width: number;
  autosave: boolean;
  serif: boolean;
  bodyFont?: string;
  codeFont?: string;
  attachmentMode: 'relative' | 'embedded';
  markdownCompatibility?: boolean;
  customColors?: { paper: string; ink: string; accent: string };
};
export type Heading = { level: number; text: string; line: number; id: string };
export type SearchHit = { path: string; line: number; text: string };
