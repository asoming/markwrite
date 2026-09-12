import {
  browserInlineMetrics,
  inlineFormulaLines,
  type InlineMetrics,
  type InlineParagraphStyle,
} from './exportInline';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ParagraphChild, FileChild } from 'docx';
import fontCoverage from './export-font-coverage.json';
import { imageDimension } from './imageMarkup';

export type ExportFormat = 'pdf' | 'docx';
export type ExportOptions = {
  template?: 'standard' | 'academic' | 'compact';
  equations?: 'editable' | 'image';
  paper?: 'A4' | 'LETTER' | 'A5';
  /** Page margins in millimetres. Omitted values follow the selected template. */
  margins?: { top: number; right: number; bottom: number; left: number };
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
  cover?: boolean;
  coverSubtitle?: string;
  toc?: boolean;
  language?: 'zh-CN' | 'en';
};
const paperSizes = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
  A5: { width: 419.53, height: 595.28 },
};
const pointsPerMm = 72 / 25.4;
export function exportPageLayout(options: ExportOptions = {}) {
  const paper = options.paper && options.paper in paperSizes ? options.paper : 'A4';
  const defaultMargin = profile(options).margin / pointsPerMm;
  const margins = options.margins || {
    top: defaultMargin,
    right: defaultMargin,
    bottom: defaultMargin,
    left: defaultMargin,
  };
  if (
    Object.values(margins).length !== 4 ||
    Object.values(margins).some((value) => !Number.isFinite(value) || value < 12 || value > 40)
  )
    throw new Error(
      options.language === 'en'
        ? 'Page margins must be between 12 and 40 mm.'
        : '页边距须在 12–40 毫米之间。',
    );
  for (const value of [options.header, options.footer])
    if (value && (value.length > 40 || /[\r\n]/.test(value)))
      throw new Error(
        options.language === 'en'
          ? 'Headers and footers must be a single line of up to 40 characters.'
          : '页眉、页脚须为单行文字，且不超过 40 个字符。',
      );
  const pt = Object.fromEntries(
    Object.entries(margins).map(([key, value]) => [key, value * pointsPerMm]),
  ) as typeof margins;
  return {
    paper,
    ...paperSizes[paper],
    margins,
    pt,
    contentWidth: paperSizes[paper].width - pt.left - pt.right,
    contentHeight: paperSizes[paper].height - pt.top - pt.bottom,
  };
}
function plainHeading(block: ExportBlock) {
  return block.kind === 'paragraph' && block.heading
    ? block.runs
        .map((run) => (run.kind === 'text' ? run.text : ''))
        .join('')
        .trim()
    : '';
}
function documentTitle(title: string) {
  return title.replace(/\.(md|markdown)$/i, '') || 'Markwrite';
}
type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  code?: boolean;
  link?: string;
};
export type ExportRun = ({ kind: 'text'; text: string } & TextStyle) | ExportImage;
export type ExportImage = {
  kind: 'image';
  source: string;
  svg?: string;
  width: number;
  height: number;
  alt: string;
  inline?: boolean;
  baseline?: number;
  tex?: string;
};
export type ExportBlock =
  | {
      kind: 'paragraph';
      runs: ExportRun[];
      heading?: number;
      quote?: boolean;
      indent?: number;
      code?: boolean;
      alignment?: 'left' | 'center' | 'right';
    }
  | { kind: 'table'; rows: ExportRun[][][]; header: boolean }
  | { kind: 'rule' };

const profiles = {
  standard: { size: 11, lineHeight: 1.45, margin: 48, gap: 9 },
  academic: { size: 12, lineHeight: 1.7, margin: 60, gap: 12 },
  compact: { size: 10, lineHeight: 1.25, margin: 40, gap: 6 },
};
const profile = (options: ExportOptions) => profiles[options.template || 'standard'];
const safeLink = (href: string) => /^(https?:\/\/|mailto:|#)/i.test(href);

function imageSize(svg: SVGElement) {
  const box = (svg.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
  const absolute = (name: string) => {
    const value = svg.getAttribute(name) || '';
    return /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : 0;
  };
  const width = absolute('width') || box[2] || 600;
  const height = absolute('height') || box[3] || 300;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('图形尺寸无效，无法导出。');
  return { width, height };
}
function svgImage(svg: SVGElement, alt: string): ExportImage {
  const clone = svg.cloneNode(true) as SVGElement;
  if (clone.querySelector('foreignObject'))
    throw new Error('图表含有无法可靠导出的 HTML 标签，请改用 Mermaid 的纯 SVG 标签。');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const size = imageSize(clone);
  clone.setAttribute('width', String(size.width));
  clone.setAttribute('height', String(size.height));
  // Mermaid uses CSS rules and variables. Resolve them with the browser before
  // handing the image to PDF readers, whose SVG CSS support varies widely.
  if (clone.querySelector('style')) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
    host.append(clone);
    document.body.append(host);
    try {
      const properties = [
        'fill',
        'fill-opacity',
        'stroke',
        'stroke-width',
        'stroke-opacity',
        'stroke-dasharray',
        'stroke-linecap',
        'stroke-linejoin',
        'opacity',
        'color',
        'font-family',
        'font-size',
        'font-weight',
        'font-style',
        'text-anchor',
        'dominant-baseline',
        'stop-color',
        'stop-opacity',
      ];
      const styles = [clone, ...clone.querySelectorAll('*')]
        .filter((element) => element.tagName !== 'style')
        .map((element) => {
          const computed = getComputedStyle(element);
          return [
            element,
            properties.map((property) => [property, computed.getPropertyValue(property)] as const),
          ] as const;
        });
      for (const [element, values] of styles) {
        element.removeAttribute('style');
        for (const [property, value] of values) {
          if (!value) continue;
          const resolved =
            property === 'stroke-dasharray' && value !== 'none'
              ? value
                  .split(/[ ,]+/)
                  .map((part) => Math.max(0.001, parseFloat(part)))
                  .join(' ')
              : value;
          element.setAttribute(property, resolved);
        }
      }
      clone.querySelectorAll('style').forEach((style) => style.remove());
    } finally {
      host.remove();
    }
  }
  const source = new XMLSerializer().serializeToString(clone);
  return { kind: 'image', source, svg: source, ...size, alt };
}
async function rasterImage(node: HTMLImageElement): Promise<ExportImage> {
  const source = node.getAttribute('src') || '';
  if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(source))
    throw new Error(`图片“${node.alt || '未命名'}”尚未加载，无法完整导出。`);
  let width = node.naturalWidth;
  let height = node.naturalHeight;
  if (/^data:image\/png;base64,/i.test(source)) {
    const bytes = Uint8Array.from(atob(source.slice(source.indexOf(',') + 1)), (x) =>
      x.charCodeAt(0),
    );
    if (bytes.length >= 24) {
      const header = new DataView(bytes.buffer);
      width = header.getUint32(16);
      height = header.getUint32(20);
    }
  }
  if (!width || !height) {
    const image = await loadImage(source);
    width = image.naturalWidth;
    height = image.naturalHeight;
  }
  if (!width || !height) throw new Error(`图片“${node.alt}”尺寸无效。`);
  const displayWidth = imageDimension(node.getAttribute('width'));
  const displayHeight = imageDimension(node.getAttribute('height'));
  const naturalWidth = width,
    naturalHeight = height;
  if (displayWidth) width = displayWidth;
  else if (displayHeight) width = (naturalWidth * displayHeight) / naturalHeight;
  if (displayHeight) height = displayHeight;
  else if (displayWidth) height = (naturalHeight * displayWidth) / naturalWidth;
  // Both output libraries reliably support PNG and JPEG. Decode other accepted
  // browser formats to PNG rather than silently embedding unsupported bytes.
  return {
    kind: 'image',
    source: /^data:image\/(png|jpe?g);/i.test(source)
      ? source
      : await rasterize(source, width, height),
    width,
    height,
    alt: node.alt || '图片',
  };
}
async function inline(nodes: Iterable<Node>, style: TextStyle = {}): Promise<ExportRun[]> {
  const result: ExportRun[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent)
        result.push({ kind: 'text', text: node.textContent.replace(/\s+/g, ' '), ...style });
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (node.matches('script,style')) continue;
    if (node.matches('[data-tex]')) {
      const { formulaSvg } = await import('./exportMath');
      const template = document.createElement('template');
      template.innerHTML = formulaSvg(
        decodeURIComponent(node.getAttribute('data-tex')!),
        node.getAttribute('data-display') === 'true',
      );
      const svg = template.content.querySelector('svg')!;
      result.push({
        ...svgImage(svg, '公式'),
        tex: decodeURIComponent(node.getAttribute('data-tex')!),
        inline: node.getAttribute('data-display') !== 'true',
        baseline: Number(svg.getAttribute('data-baseline')) || undefined,
      });
    } else if (node.matches('.katex')) {
      throw new Error('公式缺少原始表达式，无法完整导出，请重新打开导出窗口。');
    } else if (node instanceof HTMLImageElement) {
      result.push(await rasterImage(node));
    } else if (node instanceof SVGElement && node.tagName.toLowerCase() === 'svg') {
      result.push(svgImage(node, '图表'));
    } else if (node.matches('br')) {
      result.push({ kind: 'text', text: '\n', ...style });
    } else if (node.matches('.footnote-backref')) {
      result.push({
        kind: 'text',
        text: '[back]',
        ...style,
        link: node.getAttribute('href') || undefined,
      });
    } else if (node.matches('.task-check')) {
      result.push({
        kind: 'text',
        text: node.classList.contains('checked') ? '[x] ' : '[ ] ',
        ...style,
      });
    } else {
      const next = { ...style };
      if (node.matches('strong,b')) next.bold = true;
      if (node.matches('em,i')) next.italic = true;
      if (node.matches('s,del')) next.strike = true;
      if (node.matches('sup')) next.superscript = true;
      if (node.matches('sub')) next.subscript = true;
      if (node.matches('code')) next.code = true;
      if (node.matches('a')) {
        const href = node.getAttribute('href') || '';
        if (safeLink(href)) next.link = href;
      }
      result.push(...(await inline(node.childNodes, next)));
    }
  }
  return result;
}

/** Convert a sanitized article after local images and Mermaid have been hydrated. */
export async function collectExportBlocks(article: HTMLElement): Promise<ExportBlock[]> {
  if (article.querySelector('.diagram-error,.math-error'))
    throw new Error('文档中有公式或图表语法错误，请修正后再导出。');
  if ([...article.querySelectorAll('[data-diagram]')].some((node) => !node.querySelector('svg')))
    throw new Error('图表尚未完成渲染，请稍后再导出。');
  const blocks: ExportBlock[] = [];
  async function walk(
    parent: Element,
    quote = false,
    indent = 0,
    alignment?: 'left' | 'center' | 'right',
  ) {
    let pending: Node[] = [];
    const flush = async () => {
      if (pending.some((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim()))
        blocks.push({ kind: 'paragraph', runs: await inline(pending), quote, indent, alignment });
      pending = [];
    };
    for (const node of parent.childNodes) {
      if (!(node instanceof Element)) {
        pending.push(node);
        continue;
      }
      if (
        node.matches(
          'h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,table,hr,div,section,article,figure,figcaption',
        )
      ) {
        await flush();
        if (node.matches('h1,h2,h3,h4,h5,h6,p,figcaption')) {
          blocks.push({
            kind: 'paragraph',
            runs: await inline(node.childNodes),
            heading: /^H[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : undefined,
            quote,
            indent,
            alignment,
          });
        } else if (node.matches('figure')) {
          const value = (node as HTMLElement).style.textAlign;
          await walk(
            node,
            quote,
            indent,
            ['left', 'center', 'right'].includes(value)
              ? (value as 'left' | 'center' | 'right')
              : alignment,
          );
        } else if (node.matches('pre')) {
          blocks.push({
            kind: 'paragraph',
            runs: [{ kind: 'text', text: node.textContent || '', code: true }],
            code: true,
            quote,
            indent,
            alignment,
          });
        } else if (node.matches('hr')) blocks.push({ kind: 'rule' });
        else if (node.matches('blockquote')) await walk(node, true, indent + 1);
        else if (node.matches('ul,ol')) {
          let index = Number(node.getAttribute('start') || 1);
          for (const item of node.children) {
            if (!item.matches('li')) continue;
            const flat = [...item.childNodes].filter(
              (child) => !(child instanceof Element && child.matches('ul,ol')),
            );
            const prefix = node.matches('ol') ? `${index++}. ` : '• ';
            blocks.push({
              kind: 'paragraph',
              runs: [{ kind: 'text', text: prefix }, ...(await inline(flat))],
              quote,
              indent: indent + 1,
            });
            for (const child of item.children)
              if (child.matches('ul,ol')) {
                const wrapper = document.createElement('div');
                wrapper.append(child.cloneNode(true));
                await walk(wrapper, quote, indent + 1);
              }
          }
        } else if (node.matches('table')) {
          const rows: ExportRun[][][] = [];
          for (const row of node.querySelectorAll('tr')) {
            if (row.closest('table') !== node) continue;
            const cells: ExportRun[][] = [];
            for (const cell of row.children) {
              if (
                (Number(cell.getAttribute('colspan')) || 1) > 1 ||
                (Number(cell.getAttribute('rowspan')) || 1) > 1
              )
                throw new Error('导出暂不支持合并表格单元格，请先取消合并。');
              cells.push(await inline(cell.childNodes, cell.matches('th') ? { bold: true } : {}));
            }
            rows.push(cells);
          }
          const width = Math.max(0, ...rows.map((row) => row.length));
          for (const row of rows) while (row.length < width) row.push([]);
          if (width)
            blocks.push({ kind: 'table', rows, header: Boolean(node.querySelector('thead,th')) });
        } else if (node.matches('[data-tex],.diagram')) {
          blocks.push({ kind: 'paragraph', runs: await inline([node]), quote, indent });
        } else await walk(node, quote, indent);
      } else pending.push(node);
    }
    await flush();
  }
  await walk(article);
  return blocks;
}

function pdfText(run: Extract<ExportRun, { kind: 'text' }>): ContentText {
  return {
    text: run.text,
    preserveLeadingSpaces: run.code,
    bold: run.bold,
    italics: run.italic,
    decoration: run.strike ? 'lineThrough' : undefined,
    sup: run.superscript,
    sub: run.subscript,
    background: run.code ? '#f2f3f6' : undefined,
    color: run.link ? '#4361d9' : undefined,
    link: run.link?.startsWith('#') ? undefined : run.link,
  };
}
function pdfRuns(
  runs: ExportRun[],
  maxWidth: number,
  maxHeight: number,
  style: InlineParagraphStyle,
): Content[] {
  if (runs.some((run) => run.kind === 'image' && run.inline && run.svg)) {
    const result: Content[] = [];
    let inline: ExportRun[] = [];
    const flush = () => {
      if (inline.length)
        result.push(...inlineFormulaLines(inline, maxWidth, { ...style, maxHeight }));
      inline = [];
    };
    for (const run of runs) {
      if (run.kind === 'text' || (run.inline && run.svg)) inline.push(run);
      else {
        flush();
        result.push(...pdfRuns([run], maxWidth, maxHeight, style));
      }
    }
    flush();
    return result;
  }
  const content: Content[] = [];
  let text: ContentText[] = [];
  const flush = () => {
    if (text.length) content.push({ text });
    text = [];
  };
  for (const run of runs) {
    if (run.kind === 'text') text.push(pdfText(run));
    else {
      flush();
      const width = Math.min(run.width * 0.75, Math.max(8, maxWidth));
      const height = Math.min((run.height * width) / run.width, maxHeight);
      const actualWidth = (height * run.width) / run.height;
      content.push(
        run.svg
          ? { svg: run.svg, width: actualWidth, height, font: 'Noto', margin: [0, 5, 0, 5] }
          : { image: run.source, width: actualWidth, height, margin: [0, 5, 0, 5] },
      );
    }
  }
  flush();
  return content.length ? content : [{ text: '' }];
}
export function pdfDefinition(
  blocks: ExportBlock[],
  title: string,
  options: ExportOptions = {},
  inlineMetrics?: InlineMetrics,
): TDocumentDefinitions {
  const missing = new Set<string>();
  const checked = new Set<number>();
  function hasGlyph(point: number) {
    let low = 0,
      high = fontCoverage.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end] = fontCoverage[middle];
      if (point < start) high = middle - 1;
      else if (point > end) low = middle + 1;
      else return true;
    }
    return false;
  }
  function validate(runs: ExportRun[]) {
    for (const run of runs) {
      const text =
        run.kind === 'text'
          ? run.text
          : run.svg
            ? new DOMParser().parseFromString(run.svg, 'image/svg+xml').documentElement
                .textContent || ''
            : '';
      for (const character of text) {
        if (/\s|[\u200B-\u200D\uFE00-\uFE0F]/u.test(character)) continue;
        const point = character.codePointAt(0)!;
        if (checked.has(point)) continue;
        checked.add(point);
        if (!hasGlyph(point)) missing.add(character);
      }
    }
  }
  for (const block of blocks) {
    if (block.kind === 'paragraph') validate(block.runs);
    else if (block.kind === 'table')
      for (const row of block.rows) for (const cell of row) validate(cell);
  }
  validate([
    { kind: 'text', text: options.header || '' },
    { kind: 'text', text: options.footer || '' },
    { kind: 'text', text: options.cover ? documentTitle(title) : '' },
    { kind: 'text', text: options.cover ? options.coverSubtitle || '' : '' },
  ]);
  if (missing.size)
    throw new Error(
      `PDF 内置字体暂不支持这些字符：${[...missing].slice(0, 8).join(' ')}。请使用 DOCX / HTML 导出，或替换这些字符。`,
    );
  const p = profile(options),
    page = exportPageLayout(options),
    width = page.contentWidth;
  const maxImageHeight = Math.max(50, page.contentHeight - p.gap * 4 - 20);
  const content: Content[] = blocks.map((block, index): Content => {
    if (block.kind === 'rule')
      return {
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.5, lineColor: '#d9dde5' },
        ],
        margin: [0, 12, 0, 12],
      };
    if (block.kind === 'table')
      return {
        table: {
          headerRows: block.header ? 1 : 0,
          widths: block.rows[0].map(() => '*'),
          body: block.rows.map((row, ri) =>
            row.map((cell) => ({
              stack: pdfRuns(cell, width / row.length - 18, maxImageHeight - 20, {
                size: p.size,
                lineHeight: p.lineHeight,
                metrics: inlineMetrics,
              }),
              fillColor: ri === 0 && block.header ? '#f3f4f7' : undefined,
              margin: [4, 5, 4, 5],
            })),
          ),
        },
        layout: 'lightHorizontalLines',
        margin: [0, 4, 0, p.gap],
      };
    const paragraph = pdfRuns(block.runs, width - (block.indent || 0) * 14, maxImageHeight, {
      size: block.heading
        ? [24, 19, 16, 14, 12, 11][block.heading - 1]
        : block.code
          ? p.size - 1
          : p.size,
      bold: Boolean(block.heading),
      lineHeight: block.heading ? 1.2 : p.lineHeight,
      color: block.quote ? '#657080' : undefined,
      metrics: inlineMetrics,
    });
    if (options.toc && plainHeading(block)) {
      const text = paragraph.find((item) => typeof item === 'object' && 'text' in item);
      if (text)
        Object.assign(text, {
          id: `heading-${index}`,
          tocItem: true,
          tocMargin: [(block.heading! - 1) * 12, 4, 0, 4],
          tocStyle: { fontSize: p.size, bold: false, color: '#24272e' },
          tocNumberStyle: { fontSize: p.size, bold: false, color: '#737b89' },
        });
    }
    return {
      stack: paragraph,
      alignment: block.alignment,
      margin: [(block.indent || 0) * 14, block.heading ? p.gap * 1.7 : 0, 0, p.gap],
      color: block.quote ? '#657080' : undefined,
      fontSize: block.heading
        ? [24, 19, 16, 14, 12, 11][block.heading - 1]
        : block.code
          ? p.size - 1
          : p.size,
      bold: Boolean(block.heading),
      lineHeight: block.heading ? 1.2 : p.lineHeight,
      unbreakable: Boolean(block.heading),
    };
  });
  const front: Content[] = [];
  if (options.cover)
    front.push({
      stack: [
        {
          text: documentTitle(title),
          bold: true,
          fontSize: 28,
          lineHeight: 1.2,
          margin: [0, Math.min(100, page.contentHeight / 5), 0, 24],
        },
        { text: options.coverSubtitle || '', fontSize: 14, color: '#657080' },
      ],
      alignment: 'center',
      pageBreak: 'after',
    });
  if (options.toc && blocks.some(plainHeading))
    front.push({
      toc: {
        title: {
          text: options.language === 'en' ? 'Contents' : '目录',
          fontSize: 22,
          bold: true,
          margin: [0, 0, 0, 20],
        },
      },
      pageBreak: 'after',
    });
  return {
    pageSize: page.paper,
    pageMargins: [page.pt.left, page.pt.top, page.pt.right, page.pt.bottom],
    info: { title, creator: 'Markwrite' },
    defaultStyle: { font: 'Noto', fontSize: p.size, lineHeight: p.lineHeight, color: '#24272e' },
    content: [...front, ...(content.length ? content : [{ text: ' ' }])],
    header: options.header
      ? (current) =>
          options.cover && current === 1
            ? { text: '' }
            : {
                text: options.header!,
                fontSize: 8,
                color: '#737b89',
                margin: [page.pt.left, 8, page.pt.right, 0],
              }
      : undefined,
    footer:
      options.footer || options.pageNumbers !== false
        ? (current, total) => {
            if (options.cover && current === 1) return { text: '' };
            return {
              columns: [
                { text: options.footer || '', width: '*', alignment: 'left' },
                ...(options.pageNumbers !== false
                  ? [{ text: `${current} / ${total}`, width: 55, alignment: 'right' as const }]
                  : []),
              ],
              fontSize: 8,
              color: '#737b89',
              margin: [page.pt.left, 5, page.pt.right, 0],
            };
          }
        : undefined,
  };
}
let fonts: Promise<Record<string, string>> | undefined;
function loadFonts() {
  return (fonts ||= Promise.all(
    ['Regular', 'Bold'].map(async (weight) => {
      const name = `NotoSansCJKsc-${weight}.otf`;
      const response = await fetch(new URL(`fonts/${name}`, document.baseURI));
      if (!response.ok) throw new Error('内置中文字体读取失败，请重新安装应用。');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return [name, btoa(binary)] as const;
    }),
  )
    .then(Object.fromEntries)
    .catch((error) => {
      fonts = undefined;
      throw error;
    }));
}
export async function buildPdf(
  blocks: ExportBlock[],
  title: string,
  options: ExportOptions = {},
  fontData?: Record<string, string>,
): Promise<Uint8Array> {
  const { default: pdfMake } = await import('pdfmake/build/pdfmake');
  const vfs = fontData || (await loadFonts());
  const hasInlineMath = blocks.some((block) =>
    block.kind === 'paragraph'
      ? block.runs.some((run) => run.kind === 'image' && run.inline)
      : block.kind === 'table' &&
        block.rows.some((row) =>
          row.some((cell) => cell.some((run) => run.kind === 'image' && run.inline)),
        ),
  );
  const metrics = hasInlineMath ? await browserInlineMetrics(vfs) : undefined;
  const family = {
    normal: 'NotoSansCJKsc-Regular.otf',
    bold: 'NotoSansCJKsc-Bold.otf',
    italics: 'NotoSansCJKsc-Regular.otf',
    bolditalics: 'NotoSansCJKsc-Bold.otf',
  };
  return new Promise((resolve, reject) => {
    try {
      // Every font and image is local, so the synchronous stream constructor
      // surfaces layout failures here instead of losing an async callback error.
      const stream = pdfMake
        .createPdf(pdfDefinition(blocks, title, options, metrics), undefined, { Noto: family }, vfs)
        .getStream();
      const chunks: Uint8Array[] = [];
      stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => {
        const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(result);
      });
      stream.end();
    } catch (error) {
      reject(error);
    }
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error('图片解码超时，导出已停止。')), 15000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error('图片无法解码，导出已停止。'));
    };
    image.src = source;
  });
}
async function rasterize(source: string, width: number, height: number): Promise<string> {
  const data = source.startsWith('<svg')
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
    : source;
  const image = await loadImage(data);
  const scale = Math.min(2, 4096 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法转换图片，导出已停止。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
export async function buildDocx(
  blocks: ExportBlock[],
  title: string,
  options: ExportOptions = {},
  renderImage = rasterize,
): Promise<Uint8Array> {
  const d = await import('docx');
  const p = profile(options),
    page = exportPageLayout(options);
  const maxWidth = page.contentWidth / 0.75;
  const maxHeight = Math.max(50, page.contentHeight - p.gap * 4 - 20) / 0.75;
  async function runs(input: ExportRun[], width = maxWidth): Promise<ParagraphChild[]> {
    return Promise.all(
      input.map(async (run): Promise<ParagraphChild> => {
        if (run.kind === 'text') {
          const text = new d.TextRun({
            children: run.text
              .split('\n')
              .flatMap((part, i) => (i ? [new d.CarriageReturn(), part] : [part])),
            bold: run.bold,
            italics: run.italic,
            strike: run.strike,
            superScript: run.superscript,
            subScript: run.subscript,
            font: run.code ? { ascii: 'Consolas', eastAsia: 'Noto Sans CJK SC' } : undefined,
            color: run.link ? '4361D9' : undefined,
          });
          return run.link && !run.link.startsWith('#')
            ? new d.ExternalHyperlink({ children: [text], link: run.link })
            : text;
        }
        if (run.tex !== undefined && options.equations !== 'image') {
          const { editableFormula } = await import('./officeMath');
          return editableFormula(run.tex, !run.inline);
        }
        const ratio = Math.min(1, Math.max(8, width) / run.width, maxHeight / run.height);
        const transformation = { width: run.width * ratio, height: run.height * ratio };
        const altText = { title: run.alt, description: run.alt, name: run.alt };
        if (run.svg)
          return new d.ImageRun({
            type: 'svg',
            data: Uint8Array.from(new TextEncoder().encode(run.svg)),
            fallback: { type: 'png', data: await renderImage(run.svg, run.width, run.height) },
            transformation,
            altText,
          });
        return new d.ImageRun({
          type: /^data:image\/jpe?g/i.test(run.source) ? 'jpg' : 'png',
          data: run.source,
          transformation,
          altText,
        });
      }),
    );
  }
  const children: FileChild[] = [];
  if (options.cover) {
    children.push(
      new d.Paragraph({
        alignment: d.AlignmentType.CENTER,
        spacing: { before: Math.min(100, page.contentHeight / 5) * 20, after: 480 },
        children: [new d.TextRun({ text: documentTitle(title), bold: true, size: 56 })],
      }),
    );
    if (options.coverSubtitle)
      children.push(
        new d.Paragraph({
          alignment: d.AlignmentType.CENTER,
          children: [new d.TextRun({ text: options.coverSubtitle, size: 28, color: '657080' })],
        }),
      );
    children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
  }
  if (options.toc && blocks.some(plainHeading)) {
    children.push(
      new d.Paragraph({
        children: [
          new d.TextRun({
            text: options.language === 'en' ? 'Contents' : '目录',
            size: 44,
            bold: true,
          }),
        ],
        spacing: { after: 400 },
        keepNext: true,
      }),
    );
    blocks.forEach((block, index) => {
      const text = plainHeading(block);
      if (!text || block.kind !== 'paragraph') return;
      children.push(
        new d.Paragraph({
          indent: { left: (block.heading! - 1) * 240 },
          spacing: { after: 120 },
          children: [
            new d.InternalHyperlink({
              anchor: `heading_${index}`,
              children: [new d.TextRun({ text, color: '4361D9' })],
            }),
          ],
        }),
      );
    });
    children.push(new d.Paragraph({ children: [new d.PageBreak()] }));
  }
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'rule')
      children.push(
        new d.Paragraph({
          border: { bottom: { color: 'D9DDE5', style: d.BorderStyle.SINGLE, size: 4 } },
          spacing: { after: 160 },
        }),
      );
    else if (block.kind === 'table') {
      const rowCount = block.rows.length;
      const rows = [];
      for (let ri = 0; ri < rowCount; ri++) {
        const row = block.rows[ri];
        const cells = [];
        for (const cell of row)
          cells.push(
            new d.TableCell({
              children: [
                new d.Paragraph({ children: await runs(cell, maxWidth / row.length - 16) }),
              ],
              shading: ri === 0 && block.header ? { fill: 'F3F4F7' } : undefined,
              margins: { top: 80, bottom: 80, left: 100, right: 100 },
            }),
          );
        rows.push(new d.TableRow({ children: cells, tableHeader: ri === 0 && block.header }));
      }
      children.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } }));
      children.push(new d.Paragraph({ spacing: { after: p.gap * 20 } }));
    } else
      children.push(
        new d.Paragraph({
          children:
            options.toc && plainHeading(block)
              ? [
                  new d.Bookmark({
                    id: `heading_${index}`,
                    children: await runs(block.runs, maxWidth - (block.indent || 0) * 20),
                  }),
                ]
              : await runs(block.runs, maxWidth - (block.indent || 0) * 20),
          heading: block.heading
            ? [
                d.HeadingLevel.HEADING_1,
                d.HeadingLevel.HEADING_2,
                d.HeadingLevel.HEADING_3,
                d.HeadingLevel.HEADING_4,
                d.HeadingLevel.HEADING_5,
                d.HeadingLevel.HEADING_6,
              ][block.heading - 1]
            : undefined,
          alignment: block.alignment,
          indent: { left: (block.indent || 0) * 280 },
          spacing: {
            after: p.gap * 20,
            before: block.heading ? p.gap * 30 : 0,
            line: p.lineHeight * 240,
            lineRule: d.LineRuleType.AUTO,
          },
          keepNext: Boolean(block.heading),
          shading: block.code ? { fill: 'F3F4F7' } : undefined,
          border: block.quote
            ? { left: { style: d.BorderStyle.SINGLE, color: '8798E2', size: 12, space: 10 } }
            : undefined,
        }),
      );
  }
  const documentFile = new d.Document({
    title,
    creator: 'Markwrite',
    description: 'Exported by Markwrite',
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: 'Calibri', eastAsia: 'Noto Sans CJK SC', hAnsi: 'Calibri' },
            size: p.size * 2,
          },
          paragraph: { spacing: { line: p.lineHeight * 240, lineRule: d.LineRuleType.AUTO } },
        },
      },
    },
    sections: [
      {
        properties: {
          titlePage: options.cover,
          page: {
            size: { width: Math.round(page.width * 20), height: Math.round(page.height * 20) },
            margin: {
              top: Math.round(page.pt.top * 20),
              right: Math.round(page.pt.right * 20),
              bottom: Math.round(page.pt.bottom * 20),
              left: Math.round(page.pt.left * 20),
              header: 160,
              footer: 100,
            },
          },
        },
        headers: options.header
          ? {
              default: new d.Header({
                children: [
                  new d.Paragraph({
                    children: [new d.TextRun({ text: options.header, size: 16, color: '737B89' })],
                  }),
                ],
              }),
              ...(options.cover
                ? { first: new d.Header({ children: [new d.Paragraph('')] }) }
                : {}),
            }
          : undefined,
        footers:
          options.footer || options.pageNumbers !== false
            ? {
                default: new d.Footer({
                  children: [
                    new d.Paragraph({
                      alignment: d.AlignmentType.CENTER,
                      children: [
                        new d.TextRun({
                          children: [
                            ...(options.footer
                              ? [
                                  options.footer,
                                  ...(options.pageNumbers !== false ? ['   ·   '] : []),
                                ]
                              : []),
                            ...(options.pageNumbers !== false
                              ? [d.PageNumber.CURRENT, ' / ', d.PageNumber.TOTAL_PAGES]
                              : []),
                          ],
                          size: 16,
                          color: '737B89',
                        }),
                      ],
                    }),
                  ],
                }),
                ...(options.cover
                  ? { first: new d.Footer({ children: [new d.Paragraph('')] }) }
                  : {}),
              }
            : undefined,
        children,
      },
    ],
  });
  return new Uint8Array(await d.Packer.toArrayBuffer(documentFile));
}

export async function exportDocument(
  format: ExportFormat,
  article: HTMLElement,
  title: string,
  options: ExportOptions = {},
): Promise<boolean> {
  const blocks = await collectExportBlocks(article);
  const bytes =
    format === 'pdf'
      ? await buildPdf(blocks, title, options)
      : await buildDocx(blocks, title, options);
  return saveExportBytes(format, bytes, title);
}

/** Save the exact bytes shown by the PDF preview, without rendering a second document. */
export async function saveExportBytes(
  format: ExportFormat,
  bytes: Uint8Array,
  title: string,
): Promise<boolean> {
  const name = `${title.replace(/\.(md|markdown)$/i, '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || '未命名'}.${format}`;
  if (isTauri()) return invoke('save_export', { name, extension: format, bytes: [...bytes] });
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type:
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

/** Convert an already-hydrated, sanitized local graphic without any upload or fetch. */
export async function graphicPng(
  svg: SVGElement,
): Promise<{ source: string; width: number; height: number }> {
  if (
    [...svg.querySelectorAll('[href],[xlink\\:href]')].some((node) => {
      const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      return href && !href.startsWith('#');
    })
  )
    throw new Error(
      '图形含有外部资源，离线复制已停止。 · The graphic references external resources.',
    );
  const image = svgImage(svg, '图形 · Graphic');
  return {
    source: await rasterize(image.svg!, image.width, image.height),
    width: image.width,
    height: image.height,
  };
}
