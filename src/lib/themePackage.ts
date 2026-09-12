import postcss from 'postcss';
import type JSZip from 'jszip';
import valueParser from 'postcss-value-parser';
import { maxThemeBytes, ThemeImportError } from './themeImport';

export const maxThemePackageBytes = 20 * 1024 * 1024;
const maxResourceBytes = 4 * 1024 * 1024;
const encoder = new TextEncoder();
export type ThemePackage = { styles: string[]; read: (path: string) => Promise<Uint8Array> };
const fail = (detail: string): never => {
  throw new Error(detail);
};
function safePath(path: string): string {
  if (
    !path ||
    path.startsWith('/') ||
    /[\\\u0000-\u001f]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  )
    return fail('Invalid package path');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) return fail('Package path escapes its folder');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
export async function readThemePackage(input: File | File[]): Promise<ThemePackage> {
  const readers = new Map<string, () => Promise<Uint8Array>>();
  let total = 0;
  const add = (path: string, size: number, read: () => Promise<Uint8Array>) => {
    const key = safePath(path);
    total += size;
    if (
      readers.size >= 1000 ||
      !Number.isFinite(size) ||
      size < 0 ||
      total > maxThemePackageBytes ||
      readers.has(key)
    )
      fail('Theme package is too large or contains duplicate paths');
    readers.set(key, read);
  };
  if (Array.isArray(input)) {
    for (const file of input)
      add(
        file.webkitRelativePath || file.name,
        file.size,
        async () => new Uint8Array(await file.arrayBuffer()),
      );
  } else {
    if (input.size > maxThemePackageBytes) fail('Theme ZIP exceeds 20 MiB');
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await input.arrayBuffer());
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const original =
        (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
      if (safePath(original) !== entry.name || (Number(entry.unixPermissions) & 0xf000) === 0xa000)
        fail('Invalid package entry');
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize;
      if (size === undefined) fail('Missing package entry size');
      add(
        entry.name,
        size!,
        () =>
          new Promise((resolve, reject) => {
            const chunks: Uint8Array[] = [];
            let length = 0;
            const stream = (
              entry as typeof entry & {
                internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
              }
            ).internalStream('uint8array');
            stream
              .on('data', (chunk) => {
                length += chunk.length;
                if (length > maxResourceBytes || length > size!) {
                  stream.pause();
                  reject(new Error('Theme resource exceeds its size limit'));
                  return;
                }
                chunks.push(chunk);
              })
              .on('error', reject)
              .on('end', () => {
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                  bytes.set(chunk, offset);
                  offset += chunk.length;
                }
                resolve(bytes);
              })
              .resume();
          }),
      );
    }
  }
  const styles = [...readers.keys()]
    .filter((path) => /\.css$/i.test(path) && !path.includes('__MACOSX/'))
    .sort();
  if (!styles.length) fail('No CSS file in the theme package');
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    styles,
    read: (path) => {
      const key = safePath(path);
      const read = readers.get(key);
      if (!read) return Promise.reject(new Error(`Missing theme resource: ${key}`));
      let result = cache.get(key);
      if (!result) {
        result = read().then((bytes) => {
          if (bytes.length > maxResourceBytes) fail('Theme resource exceeds 4 MiB');
          return bytes;
        });
        cache.set(key, result);
      }
      return result;
    },
  };
}
const mime: Record<string, string> = {
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};
function relative(base: string, url: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(url))
    fail('Only local relative theme resources are supported');
  return safePath(
    base.slice(0, base.lastIndexOf('/') + 1) + decodeURIComponent(url.split(/[?#]/)[0]),
  );
}
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
/** Resolve only selected package resources. No request is made for network URLs. */
export async function compileThemePackage(bundle: ThemePackage, entry: string): Promise<string> {
  let expandedBytes = 0;
  const assets = new Map<string, string>();
  async function css(path: string, chain: string[]): Promise<string> {
    if (chain.includes(path) || chain.length >= 8) fail('Circular or overly deep CSS import');
    const bytes = await bundle.read(path);
    expandedBytes += bytes.length;
    if (expandedBytes > maxThemeBytes) throw new ThemeImportError('size');
    const tree = postcss.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const imports: import('postcss').AtRule[] = [];
    tree.walkAtRules('import', (rule) => {
      imports.push(rule);
    });
    for (const rule of imports) {
      const params = valueParser(rule.params).nodes;
      const firstIndex = params.findIndex(
        (node) => node.type !== 'space' && node.type !== 'comment',
      );
      const first = params[firstIndex];
      const url =
        first?.type === 'string'
          ? first.value
          : first?.type === 'function' && first.value.toLowerCase() === 'url'
            ? valueParser.stringify(first.nodes).replace(/^(['"])(.*)\1$/, '$2')
            : '';
      if (!url) fail('Invalid CSS import');
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) {
        rule.remove();
        continue;
      }
      const imported = postcss.parse(await css(relative(path, url), [...chain, path]));
      const condition = valueParser.stringify(params.slice(firstIndex + 1)).trim();
      if (condition && /\b(?:layer|supports)\b/i.test(condition))
        fail('CSS layer/supports imports are not supported');
      if (condition) {
        const media = postcss.atRule({ name: 'media', params: condition });
        media.append(imported.nodes);
        rule.replaceWith(media);
      } else rule.replaceWith(...imported.nodes);
    }
    // Imported rules already contain data URLs. Rewrite the current file's remaining references.
    const declarations: import('postcss').Declaration[] = [];
    tree.walkDecls((decl) => {
      declarations.push(decl);
    });
    for (const decl of declarations) {
      const value = valueParser(decl.value);
      const urls: valueParser.FunctionNode[] = [];
      value.walk((node) => {
        if (node.type === 'function' && node.value.toLowerCase() === 'url') {
          urls.push(node);
          return false;
        }
      });
      for (const node of urls) {
        const url = valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^(['"])(.*)\1$/, '$2');
        if (/^(?:data:|[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) continue;
        const resource = relative(path, url);
        const type = mime[resource.split('.').pop()!.toLowerCase()];
        if (!type) {
          node.nodes = [
            { type: 'string', quote: '"', value: '', sourceIndex: 0, sourceEndIndex: 0 },
          ];
          continue;
        }
        let data = assets.get(resource);
        if (!data) {
          data = `data:${type};base64,${base64(await bundle.read(resource))}`;
          assets.set(resource, data);
        }
        node.nodes = [
          { type: 'string', quote: '"', value: data, sourceIndex: 0, sourceEndIndex: 0 },
        ];
      }
      decl.value = value.toString();
    }
    const result = tree.toString();
    if (encoder.encode(result).length > maxThemeBytes) throw new ThemeImportError('size');
    return result;
  }
  return css(safePath(entry), []);
}
