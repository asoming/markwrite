import type { Content } from 'pdfmake/interfaces';
import type { ExportRun, ExportImage } from './export';
import { escapeHtml } from './markdownParser';
export type InlineTextRun = Extract<ExportRun, { kind: 'text' }>;
export type InlineMetrics = {
  width: (text: string, size: number, bold: boolean, italic: boolean) => number;
  ascent: number;
  descent: number;
};
const fallbackMetrics: InlineMetrics = {
  ascent: 1.16,
  descent: 0.288,
  width: (text, size) =>
    [...text].reduce(
      (sum, character) =>
        sum +
        (/\p{Script=Han}/u.test(character)
          ? size
          : /\s/.test(character)
            ? size * 0.23
            : size * 0.62),
      0,
    ),
};
export type InlineParagraphStyle = {
  size: number;
  bold?: boolean;
  color?: string;
  lineHeight: number;
  metrics?: InlineMetrics;
  maxHeight?: number;
};
/** PDF text remains selectable. Only formulas are vector paths. Line fragments are
 * valid self-contained SVG so pdfmake can paginate between lines without treating
 * every inline formula as a block image. Metrics use the very same embedded font. */
export function inlineFormulaLines(
  runs: ExportRun[],
  maxWidth: number,
  style: InlineParagraphStyle,
): Content[] {
  const metrics = style.metrics || fallbackMetrics;
  type Part = {
    run: InlineTextRun | ExportImage;
    text?: string;
    width: number;
    height: number;
    ascent: number;
  };
  const lines: Part[][] = [];
  let current: Part[] = [],
    width = 0;
  const finish = () => {
    if (current.length) lines.push(current);
    current = [];
    width = 0;
  };
  const append = (part: Part) => {
    if (current.length && width + part.width > maxWidth + 0.01) {
      const last = current.at(-1)!;
      const keepTogether =
        /^(?:[，。！？、；：）》」』】,.!?;:)\]])/.test(part.text || '') ||
        /^[（《「『【(\[]$/.test(last.text || '');
      // Keep closing punctuation with its preceding word/formula, and opening
      // brackets with their following word, when the pair fits one line.
      if (keepTogether && current.length > 1 && last.width + part.width <= maxWidth) {
        current.pop();
        finish();
        current.push(last);
        width = last.width;
      } else finish();
    }
    current.push(part);
    width += part.width;
  };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const run of runs) {
    if (run.kind === 'image') {
      const ratio = Math.min(
        (style.size / 12) * 0.75,
        maxWidth / run.width,
        (style.maxHeight || Infinity) / run.height,
      );
      append({
        run,
        width: run.width * ratio,
        height: run.height * ratio,
        ascent: (run.baseline ?? run.height * 0.8) * ratio,
      });
    } else {
      for (const line of run.text.split(/(\n)/)) {
        if (line === '\n') {
          finish();
          continue;
        }
        for (const { segment } of segmenter.segment(line)) {
          const measured = metrics.width(
            segment,
            style.size,
            run.bold || Boolean(style.bold),
            Boolean(run.italic),
          );
          const chunks =
            measured > maxWidth
              ? [...graphemes.segment(segment)].map((chunk) => chunk.segment)
              : [segment];
          for (const text of chunks) {
            const partWidth = metrics.width(
              text,
              style.size,
              run.bold || Boolean(style.bold),
              Boolean(run.italic),
            );
            if (!current.length && /^\s+$/.test(text)) continue;
            append({
              run,
              text,
              width: partWidth,
              height: (metrics.ascent + metrics.descent) * style.size,
              ascent: metrics.ascent * style.size,
            });
          }
        }
      }
    }
  }
  finish();
  return lines.map((parts): Content => {
    const baseline = Math.max(...parts.map((part) => part.ascent));
    const bottom = Math.max(...parts.map((part) => part.height - part.ascent));
    const height = Math.max(
      (metrics.ascent + metrics.descent) * style.size * style.lineHeight,
      baseline + bottom + 1,
    );
    let x = 0;
    const fragments = parts
      .map((part) => {
        const { run } = part;
        let svg: string;
        if (run.kind === 'image') {
          const image = new DOMParser().parseFromString(run.svg!, 'image/svg+xml').documentElement;
          image.setAttribute('x', String(x));
          image.setAttribute('y', String(baseline - part.ascent));
          image.setAttribute('width', String(part.width));
          image.setAttribute('height', String(part.height));
          svg = new XMLSerializer().serializeToString(image);
        } else {
          const fill = run.link ? '#4361d9' : style.color || '#24272e';
          svg = run.code
            ? `<rect x="${x}" y="${baseline - part.ascent}" width="${part.width}" height="${part.height}" fill="#f2f3f6"/>`
            : '';
          svg += `<text x="${x}" y="${baseline}" font-family="Noto" font-size="${style.size}" font-weight="${run.bold || style.bold ? 'bold' : 'normal'}" font-style="${run.italic ? 'italic' : 'normal'}" fill="${fill}" xml:space="preserve">${escapeHtml(part.text || '')}</text>`;
          if (run.strike)
            svg += `<line x1="${x}" x2="${x + part.width}" y1="${baseline - style.size * 0.3}" y2="${baseline - style.size * 0.3}" stroke="${fill}" stroke-width="0.6"/>`;
          if (run.link && /^(https?:\/\/|mailto:)/i.test(run.link))
            svg = `<a href="${escapeHtml(run.link)}">${svg}</a>`;
        }
        x += part.width;
        return svg;
      })
      .join('');
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${maxWidth}" height="${height}" viewBox="0 0 ${maxWidth} ${height}">${fragments}</svg>`,
      width: maxWidth,
      height,
      font: 'Noto',
    };
  });
}

/** Load a private FontFace from the bytes already used by PDF export. No network. */
const metricsCache = new WeakMap<Record<string, string>, Promise<InlineMetrics | undefined>>();
export function browserInlineMetrics(
  vfs: Record<string, string>,
): Promise<InlineMetrics | undefined> {
  const cached = metricsCache.get(vfs);
  if (cached) return cached;
  const prepared = createBrowserInlineMetrics(vfs).catch((error) => {
    metricsCache.delete(vfs);
    throw error;
  });
  metricsCache.set(vfs, prepared);
  return prepared;
}
async function createBrowserInlineMetrics(
  vfs: Record<string, string>,
): Promise<InlineMetrics | undefined> {
  if (typeof FontFace === 'undefined' || !document.fonts) return undefined;
  const family = 'MarkwritePdfMeasurement';
  await Promise.all(
    ['Regular', 'Bold'].map(async (weight) => {
      const bytes = Uint8Array.from(atob(vfs[`NotoSansCJKsc-${weight}.otf`]), (character) =>
        character.charCodeAt(0),
      );
      const face = new FontFace(family, bytes, { weight: weight === 'Bold' ? '700' : '400' });
      await face.load();
      document.fonts.add(face);
    }),
  );
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  const cache = new Map<string, number>();
  return {
    ascent: 1.16,
    descent: 0.288,
    width: (text, size, bold, italic) => {
      const key = `${size}:${bold}:${italic}:${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      context.font = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${size}px ${family}`;
      const width = context.measureText(text).width;
      if (cache.size < 20000) cache.set(key, width);
      return width;
    },
  };
}
