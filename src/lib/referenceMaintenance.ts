import type { Token, TokensList } from 'marked';
import { md } from './markdown';
import {
  documentFileUri,
  fileName,
  pathKey,
  relativeDocument,
  resolveDocumentLink,
  wikiResolver,
  withoutExtension,
} from './workspace';

export type ReferenceDocument = { path: string; content: string; name?: string };
export type ReferenceChange = {
  path: string;
  nextPath: string;
  before: string;
  after: string;
  count: number;
};
export type ReferenceWarning = {
  path: string;
  reference: string;
  reason: 'ambiguous-wiki' | 'unsupported-target' | 'unlocated-reference' | 'invalid-reference';
};
export type ReferenceAnalysis = { changes: ReferenceChange[]; warnings: ReferenceWarning[] };
type Span = { from: number; to: number };
type Edit = Span & { insert: string };
type Destination = Span & { value: string; angle: boolean };

function normalizedPath(path: string) {
  return resolveDocumentLink(undefined, documentFileUri(path)).path.replace(/\\/g, '/');
}

/** Maps the renamed file or an entire directory subtree, preserving the destination's native form. */
export function movedReferencePath(path: string, from: string, to: string): string {
  const key = pathKey(path);
  const oldKey = pathKey(from).replace(/\/$/, '');
  if (key === oldKey) return to;
  if (!key.startsWith(oldKey + '/')) return path;
  const suffix = normalizedPath(path).slice(oldKey.length).replace(/^\//, '');
  const separator = to.includes('\\') && !to.includes('/') ? '\\' : '/';
  return to.replace(/[\\/]+$/, '') + separator + suffix.replace(/\//g, separator);
}

function decodeEntities(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&quot;': '"',
      '&apos;': "'",
      '&lt;': '<',
      '&gt;': '>',
    };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hexadecimal = entity.toLowerCase().startsWith('&#x');
    const point = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}
function markdownDestination(raw: string, start: number): Destination | null {
  while (/[ \t]/.test(raw[start] || '') && start < raw.length) start++;
  if (raw[start] === '<') {
    for (let end = start + 1; end < raw.length; end++) {
      if (raw[end] === '\\') {
        end++;
        continue;
      }
      if (raw[end] === '>')
        return { from: start + 1, to: end, value: raw.slice(start + 1, end), angle: true };
      if (raw[end] === '\n') return null;
    }
    return null;
  }
  let depth = 0;
  let end = start;
  for (; end < raw.length; end++) {
    const character = raw[end];
    if (character === '\\') {
      end++;
      continue;
    }
    if (/\s/.test(character)) break;
    if (character === '(') depth++;
    else if (character === ')') {
      if (!depth) break;
      depth--;
    }
  }
  if (depth || end === start) return null;
  return { from: start, to: end, value: raw.slice(start, end), angle: false };
}
function inlineDestination(raw: string): Destination | null {
  let start = raw.startsWith('![') ? 1 : 0;
  if (raw[start] !== '[') return null;
  let depth = 0;
  for (; start < raw.length; start++) {
    if (raw[start] === '\\') {
      start++;
      continue;
    }
    if (raw[start] === '[') depth++;
    else if (raw[start] === ']' && --depth === 0) {
      if (raw[start + 1] !== '(') return null; // Reference-style usages are changed at their definition.
      return markdownDestination(raw, start + 2);
    }
  }
  return null;
}
function htmlDestination(tag: string, wanted: string): Destination | null {
  let offset = /^<\w+/.exec(tag)?.[0].length || 0;
  while (offset < tag.length) {
    while (/\s/.test(tag[offset] || '')) offset++;
    if (!tag[offset] || tag[offset] === '>' || tag.slice(offset, offset + 2) === '/>') return null;
    const name = /^[^\s=/>]+/.exec(tag.slice(offset));
    if (!name) return null;
    offset += name[0].length;
    while (/\s/.test(tag[offset] || '')) offset++;
    if (tag[offset] !== '=') continue;
    offset++;
    while (/\s/.test(tag[offset] || '')) offset++;
    const quote = tag[offset] === '"' || tag[offset] === "'" ? tag[offset++] : '';
    const start = offset;
    if (quote) while (offset < tag.length && tag[offset] !== quote) offset++;
    else while (offset < tag.length && !/[\s>]/.test(tag[offset])) offset++;
    if (name[0].toLowerCase() === wanted)
      return { from: start, to: offset, value: tag.slice(start, offset), angle: !!quote };
    if (quote) offset++;
  }
  return null;
}
const unescapeMarkdown = (value: string) =>
  decodeEntities(value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\\]^_`{|}~])/g, '$1'));
function encodePathLike(next: string, original: string, angle: boolean) {
  // Preserve the existing escaped-versus-readable Unicode convention. Keep generated %23/%25 intact.
  if (/%[0-9a-f]{2}/i.test(original)) {
    const scheme = /^file:\/\/[^/]*/i.exec(next)?.[0] || '';
    const rest = next.slice(scheme.length);
    return (
      scheme +
      rest
        .split('/')
        .map((part, index) => {
          if ((index === 0 || (scheme && index === 1)) && /^[a-z]:$/i.test(part)) return part;
          try {
            return encodeURIComponent(decodeURIComponent(part));
          } catch {
            return encodeURIComponent(part);
          }
        })
        .join('/')
    );
  }
  return next.replace(angle ? /[<>]/g : /[\s()<>]/g, (character) => encodeURIComponent(character));
}

export function analyzeReferenceChanges(
  documents: readonly ReferenceDocument[],
  from: string,
  to: string,
): ReferenceAnalysis {
  const changes: ReferenceChange[] = [];
  const warnings: ReferenceWarning[] = [];
  const unique = new Map<string, ReferenceDocument>();
  for (const document of documents)
    if (!unique.has(pathKey(document.path))) unique.set(pathKey(document.path), document);
  const currentDocuments = [...unique.values()];
  const moved = (path: string) => movedReferencePath(path, from, to);
  const nextDocuments = currentDocuments.map((document) => {
    const nextPath = moved(document.path);
    return {
      ...document,
      path: nextPath,
      name: nextPath === document.path ? document.name : fileName(nextPath),
    };
  });
  const oldWiki = wikiResolver(currentDocuments);
  const nextWiki = wikiResolver(nextDocuments);
  const warned = new Set<string>();

  for (const document of currentDocuments) {
    const content = document.content;
    const nextPath = moved(document.path);
    const edits: Edit[] = [];
    const protectedSpans: Span[] = [];
    const tokens = md.lexer(content) as TokensList;
    const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
    if (frontmatter) protectedSpans.push({ from: 0, to: frontmatter[0].length });
    const protectedAt = (start: number, end: number) =>
      protectedSpans.some((span) => start < span.to && end > span.from);
    function warn(reference: string, reason: ReferenceWarning['reason']) {
      const key = JSON.stringify([document.path, reference, reason]);
      if (warned.has(key)) return;
      warned.add(key);
      warnings.push({ path: document.path, reference, reason });
    }
    function rewriteHref(href: string, original: string, angle: boolean): string | null {
      const decoded = decodeEntities(href);
      if (!decoded || decoded.startsWith('#')) return null;
      if (
        /^[a-z][a-z\d+.-]*:/i.test(decoded) &&
        !/^file:/i.test(decoded) &&
        !/^[a-z]:[\\/]/i.test(decoded)
      )
        return null;
      if (decoded.startsWith('//') && !/^(?:[a-z]:|\\\\|\/\/)/i.test(document.path)) return null;
      try {
        const target = resolveDocumentLink(document.path, decoded).path;
        const nextTarget = moved(target);
        if (nextTarget === target && nextPath === document.path) return null;
        // A relative reference inside a moved subtree often remains valid verbatim.
        if (pathKey(resolveDocumentLink(nextPath, decoded).path) === pathKey(nextTarget))
          return null;
        const hash = original.indexOf('#');
        const fragment = hash < 0 ? '' : original.slice(hash);
        const oldPath = hash < 0 ? original : original.slice(0, hash);
        let result: string;
        if (/^file:/i.test(decoded)) result = documentFileUri(nextTarget);
        else if (/^[a-z]:[\\/]|^\/\/|^\\\\/i.test(decoded))
          result = normalizedPath(nextTarget).replace(/[%#?]/g, (character) =>
            encodeURIComponent(character),
          );
        else if (/^[\\/]/.test(decoded)) {
          result = normalizedPath(nextTarget).replace(/[%#?]/g, (character) =>
            encodeURIComponent(character),
          );
          const baseDrive = /^([a-z]:)/i.exec(normalizedPath(nextPath));
          if (baseDrive && result.toLowerCase().startsWith(baseDrive[1].toLowerCase() + '/'))
            result = result.slice(2);
          else if (baseDrive && /^[a-z]:/i.test(result)) result = documentFileUri(nextTarget);
        } else {
          result = relativeDocument(nextPath, nextTarget);
          if (oldPath.startsWith('./') && !/^(?:\.|\/|[a-z][a-z\d+.-]*:)/i.test(result))
            result = './' + result;
        }
        result = encodePathLike(result, oldPath, angle) + fragment;
        if (/&amp;/.test(original)) result = result.replace(/&/g, '&amp;');
        return result === original ? null : result;
      } catch {
        warn(original, 'invalid-reference');
        return null;
      }
    }
    function rewriteWiki(raw: string): string | null {
      const match = /^\[\[([^\]\n]+)\]\]$/.exec(raw);
      if (!match) return null;
      const pipe = match[1].indexOf('|');
      const targetPart = pipe < 0 ? match[1] : match[1].slice(0, pipe);
      const target = targetPart.trim();
      const hash = target.indexOf('#');
      const title = hash < 0 ? target : target.slice(0, hash);
      if (!title) return null;
      const candidates = oldWiki(target, document.path);
      if (candidates.length !== 1) {
        if (
          candidates.length > 1 &&
          (nextPath !== document.path ||
            candidates.some((candidate) => moved(candidate.path) !== candidate.path))
        )
          warn(target, 'ambiguous-wiki');
        return null;
      }
      const destination = moved(candidates[0].path);
      const stillResolved = nextWiki(target, nextPath);
      if (stillResolved.length === 1 && pathKey(stillResolved[0].path) === pathKey(destination))
        return null;
      const explicitPath = /[\\/]/.test(title);
      const extension = /\.(md|markdown)$/i.test(title);
      let newTitle = extension ? fileName(destination) : withoutExtension(fileName(destination));
      if (explicitPath || nextWiki(newTitle, nextPath).length !== 1) {
        const relative = relativeDocument(nextPath, destination);
        newTitle = /^file:/i.test(relative)
          ? normalizedPath(destination)
          : decodeURIComponent(relative);
        if (!extension) newTitle = withoutExtension(newTitle);
        if (title.startsWith('./') && !newTitle.startsWith('.')) newTitle = './' + newTitle;
        if (title.includes('\\') && !title.includes('/')) newTitle = newTitle.replace(/\//g, '\\');
      }
      if (/[#|\]\r\n]/.test(newTitle)) {
        warn(target, 'unsupported-target');
        return null;
      }
      const suffix = hash < 0 ? '' : target.slice(hash);
      const replacement = targetPart.replace(target, newTitle + suffix);
      return '[[' + replacement + (pipe < 0 ? '' : match[1].slice(pipe)) + ']]';
    }
    function processReference(token: Token, start: number) {
      if (token.type === 'wikiLink') {
        const replacement = rewriteWiki(token.raw);
        if (replacement)
          edits.push({ from: start, to: start + token.raw.length, insert: replacement });
      } else if (token.type === 'link' || token.type === 'image') {
        const destination = inlineDestination(token.raw);
        if (!destination) {
          if (token.raw.includes('](') && rewriteHref(token.href, token.href, true))
            warn(token.raw, 'unlocated-reference');
          return;
        }
        const replacement = rewriteHref(token.href, destination.value, destination.angle);
        if (replacement)
          edits.push({
            from: start + destination.from,
            to: start + destination.to,
            insert: replacement,
          });
      }
    }
    function htmlReferences(raw: string, start: number) {
      const ignored = [
        ...raw.matchAll(
          /<!--[\s\S]*?-->|<(script|style|pre|code|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        ),
      ].map((match) => ({ from: match.index!, to: match.index! + match[0].length }));
      for (const tag of raw.matchAll(/<(img|a)\b(?:"[^"]*"|'[^']*'|[^'">])*?>/gi)) {
        const tagStart = tag.index!;
        if (ignored.some((range) => tagStart >= range.from && tagStart < range.to)) continue;
        const attribute = tag[1].toLowerCase() === 'img' ? 'src' : 'href';
        const destination = htmlDestination(tag[0], attribute);
        if (!destination) continue;
        const { value } = destination;
        const replacement = rewriteHref(
          decodeEntities(value),
          decodeEntities(value),
          destination.angle,
        );
        if (replacement == null) continue;
        const escaped = replacement
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const fromIndex = start + tagStart + destination.from;
        edits.push({ from: fromIndex, to: fromIndex + value.length, insert: escaped });
      }
    }
    function children(token: Token): Token[] {
      if (token.type === 'list') return token.items as Token[];
      if (token.type === 'table')
        return [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens);
      return 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : [];
    }
    function walk(items: Token[], start: number, end: number) {
      let cursor = start;
      for (const token of items) {
        if (!token.raw) continue;
        const location = content.indexOf(token.raw, cursor);
        if (location < 0 || location + token.raw.length > end) {
          if (token.type === 'code' || token.type === 'codespan')
            protectedSpans.push({ from: start, to: end });
          else if (token.type === 'wikiLink') {
            if (rewriteWiki(token.raw)) warn(token.raw, 'unlocated-reference');
          } else if (token.type === 'link' || token.type === 'image') {
            if (rewriteHref(token.href, token.href, true)) warn(token.raw, 'unlocated-reference');
          }
          walk(children(token), cursor, end);
          continue;
        }
        const tokenEnd = location + token.raw.length;
        cursor = tokenEnd;
        if (token.type === 'code' || token.type === 'codespan') {
          protectedSpans.push({ from: location, to: tokenEnd });
          continue;
        }
        if (token.type === 'html') {
          htmlReferences(token.raw, location);
          continue;
        }
        processReference(token, location);
        walk(children(token), location, tokenEnd);
      }
    }
    walk(tokens, 0, content.length);

    // Marked removes reference definitions from its token list, but retains their resolved map.
    for (const match of content.matchAll(
      /^ {0,3}\[((?:\\.|[^\]\\\n])+)\]:[ \t]*(?:\r?\n[ \t]+)?/gm,
    )) {
      const start = match.index!;
      if (protectedAt(start, start + match[0].length)) continue;
      const label = unescapeMarkdown(match[1]).replace(/\s+/g, ' ').toLowerCase();
      const definition = tokens.links[label];
      if (!definition) continue;
      const destination = markdownDestination(content, start + match[0].length);
      if (!destination || unescapeMarkdown(destination.value) !== decodeEntities(definition.href))
        continue;
      const replacement = rewriteHref(definition.href, destination.value, destination.angle);
      if (replacement)
        edits.push({ from: destination.from, to: destination.to, insert: replacement });
    }
    const accepted: Edit[] = [];
    for (const edit of edits.sort((a, b) => a.from - b.from || a.to - b.to)) {
      if (protectedAt(edit.from, edit.to)) continue;
      const previous = accepted.at(-1);
      if (previous && edit.from < previous.to) {
        if (
          edit.from !== previous.from ||
          edit.to !== previous.to ||
          edit.insert !== previous.insert
        )
          warn(content.slice(edit.from, edit.to), 'unlocated-reference');
        continue;
      }
      accepted.push(edit);
    }
    if (!accepted.length) continue;
    let after = content;
    for (const edit of accepted.slice().reverse())
      after = after.slice(0, edit.from) + edit.insert + after.slice(edit.to);
    changes.push({ path: document.path, nextPath, before: content, after, count: accepted.length });
  }
  return { changes, warnings };
}

export function planReferenceChanges(
  documents: readonly ReferenceDocument[],
  from: string,
  to: string,
): ReferenceChange[] {
  return analyzeReferenceChanges(documents, from, to).changes;
}
