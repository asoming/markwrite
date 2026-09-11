import DOMPurify from 'dompurify';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { documentFileUri, resolveDocumentLink } from './workspace';

export type ImportSource = { name: string; path?: string; bytes: Uint8Array };
export type ImportedDocument = { name: string; content: string; warnings: string[] };
export type ImportAssets = (sourcePath: string, asset: string) => Promise<string>;
export const importLimit = 32 * 1024 * 1024;

export function validateDocx(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50)
    throw new Error('This is not a valid DOCX file.');
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65_535);
  while (end >= minimum && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < minimum || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    throw new Error('The DOCX archive is incomplete.');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  const centralEnd = offset + centralSize;
  if (view.getUint32(end + 4, true) !== 0 || count === 0xffff || centralEnd > end || count > 10_000)
    throw new Error('Unsupported or oversized DOCX archive.');
  let total = 0;
  let hasDocument = false;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error('The DOCX archive directory is invalid.');
    const flags = view.getUint16(offset + 8, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const length =
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (flags & 1 || expanded === 0xffffffff || offset + length > centralEnd)
      throw new Error('Encrypted or unsupported DOCX archive.');
    total += expanded;
    if (total > 128 * 1024 * 1024) throw new Error('The expanded DOCX exceeds 128 MiB.');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === 'word/document.xml') hasDocument = true;
    offset += length;
  }
  if (offset !== centralEnd || !hasDocument)
    throw new Error('The file does not contain a Word document.');
}

export function decodeImportText(bytes: Uint8Array): string {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('binary');
    return text.replace(/\r\n?/g, '\n');
  } catch {
    throw new Error('Use UTF-8 text, or UTF-16 text with a BOM, then import again.');
  }
}

function converter() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  service.use(gfm);
  service.addRule('table-cell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const cell = node as HTMLTableCellElement;
      const text = content
        .trim()
        .replace(/\n\s*\n/g, '<br>')
        .replace(/\n/g, ' ')
        .replace(/\|/g, '\\|');
      return `${cell.cellIndex === 0 ? '|' : ''} ${text} |`;
    },
  });
  service.addRule('complex-table', {
    filter: (node) =>
      node.nodeName === 'TABLE' && node.getAttribute('data-import-complex') === 'true',
    replacement: (_content, node) => {
      const table = node.cloneNode(true) as HTMLElement;
      table.removeAttribute('data-import-complex');
      return '\n\n' + table.outerHTML + '\n\n';
    },
  });
  service.addRule('safe-images', {
    filter: 'img',
    replacement: (_content, node) => {
      const image = node as HTMLImageElement;
      const source = image.getAttribute('src');
      return source
        ? `![${service.escape(image.getAttribute('alt') || '')}](<${source.replace(/[<>\r\n]/g, '')}>)`
        : service.escape(image.getAttribute('alt') || '');
    },
  });
  return service;
}

export async function importDocument(
  source: ImportSource,
  assets?: ImportAssets,
): Promise<ImportedDocument> {
  if (source.bytes.length > importLimit)
    throw new Error('Each import file must be smaller than 32 MiB.');
  const extension = source.name.split('.').pop()?.toLowerCase();
  if (!['txt', 'html', 'htm', 'docx'].includes(extension || ''))
    throw new Error('Supported import formats: TXT, HTML and DOCX.');
  const warnings: string[] = [];
  const service = converter();
  let content: string;
  if (extension === 'txt') {
    content = decodeImportText(source.bytes)
      .split('\n')
      .map((line) => service.escape(line))
      .join('\n');
  } else {
    let html: string;
    if (extension === 'docx') {
      validateDocx(source.bytes);
      const { default: mammoth } = await import('mammoth/mammoth.browser');
      const result = await mammoth.convertToHtml(
        { arrayBuffer: Uint8Array.from(source.bytes).buffer },
        { externalFileAccess: false, includeEmbeddedStyleMap: false },
      );
      html = result.value;
      warnings.push(...result.messages.map((message) => message.message));
    } else html = decodeImportText(source.bytes);
    // An inert document keeps image references from fetching during conversion.
    const container = document.implementation.createHTMLDocument('').body;
    container.innerHTML = DOMPurify.sanitize(html, {
      FORBID_TAGS: [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'video',
        'audio',
        'link',
        'meta',
        'base',
      ],
      FORBID_ATTR: ['style', 'srcset'],
    });
    for (const table of container.querySelectorAll('table')) {
      const rows = [...table.rows];
      if (!rows.length) continue;
      if (
        table.querySelector('table,[colspan],[rowspan]') ||
        rows.some((row) => row.cells.length !== rows[0].cells.length)
      ) {
        table.setAttribute('data-import-complex', 'true');
        warnings.push(
          'A complex table was preserved as HTML; merged cells cannot be represented in Markdown.',
        );
        continue;
      }
      for (const cell of [...rows[0].cells]) {
        if (cell.tagName === 'TH') continue;
        const header = container.ownerDocument.createElement('th');
        header.append(...cell.childNodes);
        cell.replaceWith(header);
      }
    }
    for (const link of container.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (
        !href ||
        href.startsWith('#') ||
        /^[a-z][a-z\d+.-]*:/i.test(href) ||
        href.startsWith('//')
      )
        continue;
      if (source.path) {
        try {
          const target = resolveDocumentLink(source.path, href);
          link.setAttribute(
            'href',
            documentFileUri(target.path) +
              (target.fragment ? '#' + encodeURIComponent(target.fragment) : ''),
          );
          continue;
        } catch {
          /* report an unresolved local reference */
        }
      }
      warnings.push(`Local link needs a new destination: ${href}`);
    }
    for (const image of container.querySelectorAll('img')) {
      const sourceUrl = image.getAttribute('src') || '';
      if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(sourceUrl)) continue;
      if (/^https?:\/\//i.test(sourceUrl)) continue; // A reference only; Reader requires a click to fetch.
      if (
        sourceUrl &&
        !/^[a-z][a-z\d+.-]*:/i.test(sourceUrl) &&
        !sourceUrl.startsWith('//') &&
        source.path &&
        assets
      ) {
        try {
          image.setAttribute('src', await assets(source.path, sourceUrl));
          continue;
        } catch {
          /* preserve the image description and report the missing resource */
        }
      }
      image.removeAttribute('src');
      warnings.push(`Image could not be embedded: ${sourceUrl || image.alt || '(unnamed image)'}`);
    }
    content = service.turndown(container);
  }
  if (new TextEncoder().encode(content).length > importLimit)
    throw new Error(
      'Converted Markdown exceeds 32 MiB. Split the source document before importing.',
    );
  return { name: source.name.replace(/\.[^.]+$/, '') + '.md', content, warnings };
}
