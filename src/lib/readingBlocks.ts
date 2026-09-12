import type { MarkdownBlock } from './markdownParser';

const voidTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const tags = /<!--[\s\S]*?-->|<\/?([a-z][a-z\d-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;

/** Raw HTML wrappers can cross Markdown token boundaries. Keep these wrappers together. */
export function* balancedReadingBlocks(
  blocks: Iterable<MarkdownBlock>,
  source: string,
): Generator<MarkdownBlock> {
  const stack: string[] = [];
  let pending: MarkdownBlock | undefined;
  for (const block of blocks) {
    pending = pending
      ? {
          ...pending,
          html: pending.html + block.html,
          to: Math.max(pending.to, block.to),
          toLine: Math.max(pending.toLine, block.toLine),
          headingIds: [...pending.headingIds, ...block.headingIds],
        }
      : { ...block };
    for (const match of block.html.matchAll(tags)) {
      if (!match[1]) continue;
      const name = match[1].toLowerCase(),
        closing = match[0].startsWith('</');
      if (
        ['script', 'style', 'textarea', 'title'].includes(stack[stack.length - 1]) &&
        !(closing && name === stack[stack.length - 1])
      )
        continue;
      if (closing) {
        const position = stack.lastIndexOf(name);
        if (position >= 0) stack.length = position;
      } else if (!voidTags.has(name) && !match[0].endsWith('/>')) stack.push(name);
    }
    if (!stack.length) {
      pending.raw = source.slice(pending.from, pending.to);
      yield pending;
      pending = undefined;
    }
  }
  if (pending) {
    pending.raw = source.slice(pending.from, pending.to);
    yield pending;
  }
}

/** Break only complete generated table rows/list items; references already resolved upstream. */
export function splitReadingBlock(block: MarkdownBlock, batch = 48): MarkdownBlock[] {
  const lines = block.raw.split('\n');
  const table = /^(<table\b[^>]*>[\s\S]*?<tbody>)([\s\S]*)(<\/tbody>\s*<\/table>\s*)$/i.exec(
    block.html,
  );
  if (
    table &&
    !/<table\b/i.test(table[2]) &&
    /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1] || '')
  ) {
    const rows = [...table[2].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
    if (rows.length > batch && rows.length <= lines.length - 2) {
      const result: MarkdownBlock[] = [];
      for (let first = 0; first < rows.length; first += batch) {
        const end = Math.min(rows.length, first + batch),
          sourceFirst = first ? first + 2 : 0;
        const head = first
          ? table[1]
              .replace('<thead>', '<thead data-reading-repeat="true">')
              .replace(/\s+id=(?:"[^"]*"|'[^']*')/g, '')
          : table[1];
        result.push({
          ...block,
          html: head + rows.slice(first, end).join('\n') + table[3],
          raw: lines.slice(sourceFirst, end + 2).join('\n'),
          fromLine: block.fromLine + sourceFirst,
          toLine: block.fromLine + end + 2,
        });
      }
      return result;
    }
  }
  const list = /^(<(ul|ol)\b[^>]*>)([\s\S]*)(<\/\2>\s*)$/i.exec(block.html);
  const firstMarker = /^( {0,3})(?:[-+*]|\d+[.)])[ \t]+/.exec(lines[0] || '');
  if (list && firstMarker) {
    const items: string[] = [];
    let depth = 0,
      start = -1;
    for (const match of list[3].matchAll(tags)) {
      if (match[1]?.toLowerCase() !== 'li') continue;
      if (!match[0].startsWith('</')) {
        if (depth++ === 0) start = match.index!;
      } else if (--depth === 0 && start >= 0)
        items.push(list[3].slice(start, match.index! + match[0].length));
    }
    const marker = new RegExp(`^ {${firstMarker[1].length}}(?:[-+*]|\\d+[.)])[ \\t]+`);
    const starts = lines.flatMap((line, index) => (marker.test(line) ? [index] : []));
    if (items.length > batch && items.length === starts.length) {
      const ordered = list[2].toLowerCase() === 'ol',
        initial = Number(/\bstart="(\d+)"/.exec(list[1])?.[1] || 1);
      const result: MarkdownBlock[] = [];
      for (let first = 0; first < items.length; first += batch) {
        const end = Math.min(items.length, first + batch),
          sourceEnd = starts[end] ?? lines.length;
        const head = ordered
          ? list[1].replace(/\s+start="\d+"/, '').replace(/>$/, ` start="${initial + first}">`)
          : list[1];
        result.push({
          ...block,
          html: head + items.slice(first, end).join('\n') + list[4],
          raw: lines.slice(starts[first], sourceEnd).join('\n'),
          fromLine: block.fromLine + starts[first],
          toLine: block.fromLine + sourceEnd,
        });
      }
      return result;
    }
  }
  return [block];
}
