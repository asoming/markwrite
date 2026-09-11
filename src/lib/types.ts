export type Mode = 'live' | 'source' | 'read';
export type FileEntry = { name: string; path: string; directory: boolean; children?: FileEntry[] };
export type DiskFile = {
  path: string;
  content: string;
  version: string;
  bom: boolean;
  crlf: boolean;
};
export type Document = {
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
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  lineHeight: number;
  width: number;
  autosave: boolean;
  serif: boolean;
  bodyFont?: string;
  codeFont?: string;
  attachmentMode: 'relative' | 'embedded';
  customColors?: { paper: string; ink: string; accent: string };
};
export type Heading = { level: number; text: string; line: number; id: string };
export type SearchHit = { path: string; line: number; text: string };
