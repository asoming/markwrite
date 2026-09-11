import type { Token } from 'marked';
import { md } from './markdown';

export type IndexedDocument = { path: string; content: string; name?: string };
export const fileName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path;
export const withoutExtension = (name: string) => name.replace(/\.(md|markdown)$/i, '');
export function pathKey(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const joined = parts.join('/');
  return /^[a-z]:\//i.test(joined) ? joined.toLowerCase() : joined;
}
export function relativeDocument(from: string, to: string) {
  const a = from.replace(/\\/g, '/').split('/');
  const b = to.replace(/\\/g, '/').split('/');
  a.pop();
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => '..'), ...b].join('/');
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
    const base = from?.replace(/\\/g, '/').replace(/[^/]+$/, '') || '';
    const key = pathKey(base + normalized);
    return documents.filter((d) => withoutExtension(pathKey(d.path)) === key);
  }
  return documents.filter((d) => withoutExtension(d.name || fileName(d.path)) === normalized);
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
      if (/^[a-z]+:/i.test(link.target)) return false;
      try {
        const base = doc.path.replace(/\\/g, '/').replace(/[^/]+$/, '');
        return pathKey(base + decodeURIComponent(link.target.split('#')[0])) === pathKey(target);
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
  const previous = readRecents().filter((r) => r.path !== path && r.path !== remove);
  const next = path
    ? [{ path, name: fileName(path), opened: Date.now() }, ...previous].slice(0, 30)
    : previous;
  localStorage.setItem(RECENTS, JSON.stringify(next));
  return next;
}
