import type { Token } from 'marked';
import { md } from './markdown';

export type IndexedDocument = { path: string; content: string; name?: string };
type LocalPath = { root: string; parts: string[]; windows: boolean; extended: boolean };
function parsePath(path: string): LocalPath {
  let normalized = path.replace(/\\/g, '/');
  const extended = /^\/\/\?\//.test(normalized);
  if (/^\/\/\?\/UNC\//i.test(normalized)) normalized = '//' + normalized.slice(8);
  else if (/^\/\/\?\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(4);
  let root = '',
    rest = normalized,
    windows = false;
  const drive = /^([a-z]:)\//i.exec(normalized);
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(normalized);
  if (drive) {
    root = drive[1] + '/';
    rest = normalized.slice(root.length);
    windows = true;
  } else if (unc) {
    root = `//${unc[1]}/${unc[2]}/`;
    rest = normalized.slice(unc[0].length);
    windows = true;
  } else if (normalized.startsWith('/')) {
    root = '/';
    rest = normalized.replace(/^\/+/, '');
  }
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop();
      else if (!root) parts.push(part);
    } else parts.push(part);
  }
  return { root, parts, windows, extended };
}
const displayPath = (path: LocalPath) => path.root + path.parts.join('/');
function nativePath(path: LocalPath) {
  const normalized = displayPath(path);
  if (!path.extended || !path.windows) return normalized;
  return (
    normalized.startsWith('//') ? '//?/UNC/' + normalized.slice(2) : '//?/' + normalized
  ).replace(/\//g, '\\');
}
function decodeFileUri(href: string) {
  const url = new URL(href);
  if (url.protocol !== 'file:' || url.search || url.username || url.password)
    throw new Error('本地文件链接无效。');
  let path = decodeURIComponent(url.pathname);
  if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
  else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  if (path.includes('\0')) throw new Error('本地文件链接不能包含空字符。');
  return { path, fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined };
}
function keyPath(path: string) {
  if (/^file:\/\//i.test(path)) {
    try {
      return decodeFileUri(path).path;
    } catch {
      return path;
    }
  }
  return path;
}
export const fileName = (path: string) => parsePath(keyPath(path)).parts.at(-1) || path;
export const withoutExtension = (name: string) => name.replace(/\.(md|markdown)$/i, '');
/** Comparison-only key. Never replaces the canonical native path retained in a document. */
export function pathKey(path: string) {
  const parsed = parsePath(keyPath(path));
  const value = displayPath(parsed);
  return parsed.windows ? value.toLowerCase() : value;
}
function fileUri(path: LocalPath) {
  const encode = (component: string) => encodeURIComponent(component);
  if (path.root.startsWith('//')) {
    const [server, share] = path.root.slice(2).split('/');
    return `file://${server}/${[share, ...path.parts].map(encode).join('/')}`;
  }
  if (path.windows) return `file:///${path.root}${path.parts.map(encode).join('/')}`;
  return 'file://' + path.root + path.parts.map(encode).join('/');
}
export function relativeDocument(from: string, to: string) {
  const a = parsePath(keyPath(from)),
    b = parsePath(keyPath(to));
  if (a.root.toLowerCase() !== b.root.toLowerCase() || a.windows !== b.windows) return fileUri(b);
  const directory = a.parts.slice(0, -1);
  let shared = 0;
  while (
    shared < directory.length &&
    shared < b.parts.length &&
    (a.windows
      ? directory[shared].toLowerCase() === b.parts[shared].toLowerCase()
      : directory[shared] === b.parts[shared])
  )
    shared++;
  // Keep Unicode readable in the insertion form, while URI-reserved filename characters
  // must not become fragments, query strings, or a second decoding operation.
  return [...directory.slice(shared).map(() => '..'), ...b.parts.slice(shared)]
    .map((part) => part.replace(/[%#?]/g, (character) => encodeURIComponent(character)))
    .join('/');
}
/** Resolve Markdown hrefs separately from native paths. The backend still checks authorization. */
export function resolveDocumentLink(
  from: string | undefined,
  href: string,
): { path: string; fragment?: string } {
  if (/^file:\/\//i.test(href)) {
    const decoded = decodeFileUri(href);
    return { ...decoded, path: nativePath(parsePath(decoded.path)) };
  }
  const hash = href.indexOf('#');
  const raw = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  const path = decodeURIComponent(raw);
  if (path.includes('\0')) throw new Error('本地文件链接不能包含空字符。');
  if (!path) {
    if (!from) throw new Error('请先保存文档，再打开相对链接。');
    return { path: from, fragment };
  }
  const parsed = parsePath(path);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
    throw new Error('不支持这个文档链接协议。');
  const base = from ? parsePath(keyPath(from)) : undefined;
  if (parsed.root) {
    if (parsed.root === '/' && base?.windows) {
      parsed.root = base.root;
      parsed.windows = true;
      parsed.extended = base.extended;
    }
    return { path: nativePath(parsed), fragment };
  }
  if (!base) throw new Error('请先保存文档，再打开相对链接。');
  const resolved = parsePath(base.root + [...base.parts.slice(0, -1), path].join('/'));
  resolved.extended = base.extended;
  return { path: nativePath(resolved), fragment };
}
export function wikiTargets(
  target: string,
  from: string | undefined,
  documents: IndexedDocument[],
) {
  const title = target.split('#')[0].trim();
  if (!title && from) return documents.filter((d) => pathKey(d.path) === pathKey(from));
  const normalized = withoutExtension(title.replace(/\\/g, '/'));
  if (title.includes('/') || title.includes('\\')) {
    try {
      // Wiki targets name literal files, unlike URI-encoded Markdown hrefs.
      const escaped = title.replace(/[%#?]/g, (character) => encodeURIComponent(character));
      const key = withoutExtension(pathKey(resolveDocumentLink(from, escaped).path));
      return documents.filter((d) => withoutExtension(pathKey(d.path)) === key);
    } catch {
      return [];
    }
  }
  return documents.filter((d) => {
    const name = withoutExtension(d.name || fileName(d.path));
    return parsePath(keyPath(d.path)).windows
      ? name.toLowerCase() === normalized.toLowerCase()
      : name === normalized;
  });
}
// Tokens exclude code blocks, inline code, and raw HTML from link/tag indexing.
export function documentReferences(content: string) {
  const links: { target: string; wiki: boolean }[] = [];
  const tags = new Set<string>();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'code' || token.type === 'codespan' || token.type === 'html') continue;
      if (token.type === 'wikiLink') links.push({ target: token.target, wiki: true });
      else if (token.type === 'link') links.push({ target: token.href, wiki: false });
      if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens);
      else if ('text' in token && typeof token.text === 'string')
        for (const match of token.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu))
          tags.add(match[1]);
      if (token.type === 'list') for (const item of token.items) visit(item.tokens);
      if (token.type === 'table') {
        for (const cell of [...token.header, ...token.rows.flat()]) visit(cell.tokens);
      }
    }
  };
  visit(md.lexer(content));
  return { links, tags: [...tags] };
}
export function backlinks(target: string, documents: IndexedDocument[]) {
  return documents.filter((doc) =>
    documentReferences(doc.content).links.some((link) => {
      if (link.wiki)
        return wikiTargets(link.target, doc.path, documents).some(
          (d) => pathKey(d.path) === pathKey(target),
        );
      try {
        return pathKey(resolveDocumentLink(doc.path, link.target).path) === pathKey(target);
      } catch {
        return false;
      }
    }),
  );
}

export type RecentFile = { path: string; name: string; opened: number };
const RECENTS = 'markwrite.recents.v1';
export function readRecents(): RecentFile[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENTS) || '[]');
    return Array.isArray(value)
      ? value.filter((r) => typeof r.path === 'string' && typeof r.name === 'string').slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
export function updateRecents(path?: string, remove?: string) {
  const previous = readRecents().filter(
    (r) =>
      (!path || pathKey(r.path) !== pathKey(path)) &&
      (!remove || pathKey(r.path) !== pathKey(remove)),
  );
  const next = path
    ? [{ path, name: fileName(path), opened: Date.now() }, ...previous].slice(0, 30)
    : previous;
  localStorage.setItem(RECENTS, JSON.stringify(next));
  return next;
}
