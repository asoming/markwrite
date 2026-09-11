import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
  type ChangeSpec,
} from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { findTable, splitCells } from './table';

export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'paragraph'
  | 'quote'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'indent'
  | 'outdent'
  | 'horizontalRule'
  | 'moveUp'
  | 'moveDown';
export type TableAlignment = 'left' | 'center' | 'right' | 'none';
export type TableModel = { rows: string[][]; alignments: TableAlignment[] };
const historyBoundary = isolateHistory.of('full');

/** A single transaction modifies only selected text/line prefixes, preserving unrelated Markdown. */
export function formattingTransaction(
  state: EditorState,
  action: FormatAction,
): TransactionSpec | null {
  if (state.readOnly) return null;
  const wrappers: Partial<Record<FormatAction, string>> = {
    bold: '**',
    italic: '*',
    strike: '~~',
    inlineCode: '`',
  };
  const marker = wrappers[action];
  if (marker) {
    return {
      ...state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to);
        // Inline emphasis cannot span a blank paragraph in CommonMark. Format each
        // selected text line while leaving line breaks and paragraph markers intact.
        if (text.includes('\n')) {
          const changes: ChangeSpec[] = [];
          for (const segment of text.matchAll(/[^\n]+/g)) {
            let from = range.from + segment.index;
            let value = segment[0];
            if (state.doc.lineAt(from).from === from) {
              const prefix =
                /^(?:\s*(?:#{1,6}\s+|>\s+|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+))/.exec(
                  value,
                )?.[0] || '';
              from += prefix.length;
              value = value.slice(prefix.length);
            }
            const leading = /^\s*/.exec(value)![0].length;
            from += leading;
            value = value.trim();
            if (!value) continue;
            const to = from + value.length;
            if (
              value.startsWith(marker) &&
              value.endsWith(marker) &&
              value.length > marker.length * 2
            ) {
              changes.push({ from, to: from + marker.length }, { from: to - marker.length, to });
            } else {
              const fence =
                action === 'inlineCode'
                  ? '`'.repeat(
                      Math.max(
                        1,
                        ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1),
                      ),
                    )
                  : marker;
              const padding = action === 'inlineCode' && /^`|`$/.test(value) ? ' ' : '';
              changes.push(
                { from, insert: fence + padding },
                { from: to, insert: padding + fence },
              );
            }
          }
          const changeSet = state.changes(changes);
          return {
            changes: changeSet,
            range: EditorSelection.range(
              changeSet.mapPos(range.anchor, range.anchor <= range.head ? 1 : -1),
              changeSet.mapPos(range.head, range.anchor <= range.head ? -1 : 1),
            ),
          };
        }
        if (action === 'inlineCode') {
          const left = /(`+) ?$/.exec(state.sliceDoc(0, range.from));
          const right = /^ ?(`+)/.exec(state.sliceDoc(range.to));
          if (left && right && left[1] === right[1])
            return {
              changes: [
                { from: range.from - left[0].length, to: range.from },
                { from: range.to, to: range.to + right[0].length },
              ],
              range: EditorSelection.range(
                range.anchor - left[0].length,
                range.head - left[0].length,
              ),
            };
        }
        const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
        const after = state.sliceDoc(range.to, range.to + marker.length);
        const surroundingStars =
          action === 'italic' ? /\*+$/.exec(state.sliceDoc(0, range.from))?.[0].length || 0 : 1;
        if (
          range.from >= marker.length &&
          before === marker &&
          after === marker &&
          (action !== 'italic' || surroundingStars % 2 === 1)
        ) {
          return {
            changes: [
              { from: range.from - marker.length, to: range.from },
              { from: range.to, to: range.to + marker.length },
            ],
            range: EditorSelection.range(range.anchor - marker.length, range.head - marker.length),
          };
        }
        if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
          return {
            changes: [
              { from: range.from, to: range.from + marker.length },
              { from: range.to - marker.length, to: range.to },
            ],
            range: EditorSelection.range(range.from, range.to - marker.length * 2),
          };
        }
        const fallback = action === 'inlineCode' ? '代码' : '文字';
        const inner = text || fallback;
        const fence =
          action === 'inlineCode' && inner.includes('`')
            ? '`'.repeat(Math.max(...[...inner.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
            : marker;
        const padding =
          action === 'inlineCode' && (/^`|`$/.test(inner) || /^ .+ $/.test(inner)) ? ' ' : '';
        const start = range.from + fence.length + padding.length;
        return {
          changes: {
            from: range.from,
            to: range.to,
            insert: fence + padding + inner + padding + fence,
          },
          range:
            range.anchor > range.head
              ? EditorSelection.range(start + inner.length, start)
              : EditorSelection.range(start, start + inner.length),
        };
      }),
      userEvent: 'input.format',
      annotations: historyBoundary,
      scrollIntoView: true,
    };
  }
  if (action === 'horizontalRule') return insertMarkdownTransaction(state, '\n\n---\n\n');
  if (action === 'moveUp' || action === 'moveDown')
    return moveParagraph(state, action === 'moveUp' ? -1 : 1);
  const selectedLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) selectedLines.add(n);
  }
  const lines = [...selectedLines].sort((a, b) => a - b).map((n) => state.doc.line(n));
  const listPrefix = /^(\s*)(?:[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;
  const isStyle = (text: string) =>
    action === 'quote'
      ? /^\s*>\s?/.test(text)
      : action === 'taskList'
        ? /^\s*[-+*]\s+\[[ xX]\]\s/.test(text)
        : action === 'orderedList'
          ? /^\s*\d+[.)]\s/.test(text)
          : /^\s*[-+*]\s+(?!\[[ xX]\])/.test(text);
  const toggleOff =
    ['quote', 'bulletList', 'orderedList', 'taskList'].includes(action) &&
    lines.every((line) => !line.text.trim() || isStyle(line.text));
  const changes: ChangeSpec[] = [];
  let number = 1;
  for (const line of lines) {
    let remove = 0;
    let prefix = '';
    if (action === 'indent') prefix = '  ';
    else if (action === 'outdent') remove = /^(?: {1,2}|\t)/.exec(line.text)?.[0].length || 0;
    else if (action.startsWith('heading') || action === 'paragraph') {
      remove = /^#{1,6}\s+/.exec(line.text)?.[0].length || 0;
      prefix = action === 'paragraph' ? '' : '#'.repeat(Number(action.slice(-1))) + ' ';
    } else if (action === 'quote') {
      const quote = /^(\s*)>\s?/.exec(line.text);
      remove = toggleOff ? quote?.[0].length || 0 : 0;
      prefix = toggleOff ? quote?.[1] || '' : '> ';
    } else {
      const existing = listPrefix.exec(line.text);
      const leading = existing?.[1] ?? /^\s*/.exec(line.text)![0];
      remove = existing?.[0].length ?? leading.length;
      prefix =
        leading +
        (toggleOff
          ? ''
          : action === 'orderedList'
            ? `${number++}. `
            : action === 'taskList'
              ? '- [ ] '
              : '- ');
    }
    if (remove || prefix) changes.push({ from: line.from, to: line.from + remove, insert: prefix });
  }
  const changeSet = state.changes(changes);
  return {
    changes: changeSet,
    selection: state.selection.map(changeSet),
    userEvent: 'input.format',
    annotations: historyBoundary,
    scrollIntoView: true,
  };
}

function moveParagraph(state: EditorState, direction: -1 | 1): TransactionSpec | null {
  const range = state.selection.main;
  let first = state.doc.lineAt(range.from).number;
  let last = state.doc.lineAt(range.to).number;
  if (!range.empty && state.doc.line(last).from === range.to) last--;
  while (first > 1 && state.doc.line(first - 1).text.trim()) first--;
  while (last < state.doc.lines && state.doc.line(last + 1).text.trim()) last++;
  const from = state.doc.line(first).from,
    to = state.doc.line(last).to;
  let adjacent = direction < 0 ? first - 1 : last + 1;
  while (adjacent >= 1 && adjacent <= state.doc.lines && !state.doc.line(adjacent).text.trim())
    adjacent += direction;
  if (adjacent < 1 || adjacent > state.doc.lines) return null;
  let edge = adjacent;
  while (
    edge + direction >= 1 &&
    edge + direction <= state.doc.lines &&
    state.doc.line(edge + direction).text.trim()
  )
    edge += direction;
  const neighborFrom = state.doc.line(Math.min(edge, adjacent)).from;
  const neighborTo = state.doc.line(Math.max(edge, adjacent)).to;
  const current = state.sliceDoc(from, to),
    neighbor = state.sliceDoc(neighborFrom, neighborTo);
  const separator =
    direction < 0 ? state.sliceDoc(neighborTo, from) : state.sliceDoc(to, neighborFrom);
  const offset = direction < 0 ? neighborFrom - from : neighbor.length + separator.length;
  return {
    changes: {
      from: Math.min(from, neighborFrom),
      to: Math.max(to, neighborTo),
      insert: direction < 0 ? current + separator + neighbor : neighbor + separator + current,
    },
    selection: EditorSelection.range(range.anchor + offset, range.head + offset),
    userEvent: 'move',
    annotations: historyBoundary,
    scrollIntoView: true,
  };
}

export function applyFormatting(view: EditorView, action: FormatAction): boolean {
  if (view.composing || view.state.readOnly) return false;
  const transaction = formattingTransaction(view.state, action);
  if (!transaction) return false;
  view.dispatch(transaction);
  view.focus();
  return true;
}
export function insertMarkdownTransaction(
  state: EditorState,
  markdown: string,
  range: { from: number; to: number } = state.selection.main,
): TransactionSpec {
  return {
    changes: { from: range.from, to: range.to, insert: markdown },
    selection: { anchor: range.from + markdown.length },
    userEvent: 'input.insert',
    annotations: historyBoundary,
    scrollIntoView: true,
  };
}
export function readTableAtSelection(view: EditorView) {
  if (view.state.doc.length > 300_000) return null;
  const found = findTable(
    view.state.doc.toString(),
    view.state.doc.lineAt(view.state.selection.main.head).number,
  );
  if (!found) return null;
  const rawRows = found.lines.map(splitCells);
  return {
    from: found.from,
    to: found.to,
    table: {
      rows: [rawRows[0], ...rawRows.slice(2)].map((row) =>
        row.map((cell) => cell.replace(/\\\|/g, '|')),
      ),
      alignments: rawRows[1].map((cell): TableAlignment =>
        /^:.*:$/.test(cell)
          ? 'center'
          : /:$/.test(cell)
            ? 'right'
            : /^:/.test(cell)
              ? 'left'
              : 'none',
      ),
    },
  };
}
export function tableMarkdown(table: TableModel): string {
  const count = Math.max(1, ...table.rows.map((r) => r.length), table.alignments.length);
  const row = (cells: string[]) =>
    '| ' +
    Array.from({ length: count }, (_, n) =>
      (cells[n] || '').replace(/(?<!\\)\|/g, '\\|').replace(/\r?\n/g, '<br>'),
    ).join(' | ') +
    ' |';
  const separator = Array.from(
    { length: count },
    (_, n) =>
      ({ left: ':---', center: ':---:', right: '---:', none: '---' })[
        table.alignments[n] || 'none'
      ],
  );
  return [row(table.rows[0] || []), row(separator), ...table.rows.slice(1).map(row)].join('\n');
}
export function pasteTableCells(
  table: TableModel,
  row: number,
  column: number,
  text: string,
): TableModel {
  const cells = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => line.split('\t'));
  const columns = Math.max(
    table.alignments.length,
    column + Math.max(...cells.map((r) => r.length)),
  );
  const rows = Array.from({ length: Math.max(table.rows.length, row + cells.length) }, (_, r) =>
    Array.from({ length: columns }, (_, c) => table.rows[r]?.[c] || ''),
  );
  cells.forEach((line, r) =>
    line.forEach((value, c) => {
      rows[row + r][column + c] = value;
    }),
  );
  return {
    rows,
    alignments: Array.from({ length: columns }, (_, c) => table.alignments[c] || 'none'),
  };
}

/** Converts supported clipboard HTML, never executes or loads it; unsupported elements retain text. */
export function clipboardMarkdown(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math'],
  });
  const escape = (text: string) =>
    text
      .replace(/[\\`*_[\]<>#!|]/g, '\\$&')
      .replace(/(^|\n)(\s*)([-+])(?=\s)/g, '$1$2\\$3')
      .replace(/(^|\n)(\s*\d+)([.)])(?=\s)/g, '$1$2\\$3');
  const children = (node: Node): string => [...node.childNodes].map(convert).join('');
  function convert(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent || '');
    if (!(node instanceof HTMLElement)) return '';
    const inner = () => children(node);
    const name = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(name))
      return '\n\n' + '#'.repeat(Number(name[1])) + ' ' + inner().trim() + '\n\n';
    if (name === 'p' || name === 'div') return '\n\n' + inner().trim() + '\n\n';
    if (name === 'br') return '  \n';
    if (name === 'strong' || name === 'b') return '**' + inner() + '**';
    if (name === 'em' || name === 'i') return '*' + inner() + '*';
    if (['del', 's', 'strike'].includes(name)) return '~~' + inner() + '~~';
    if (name === 'pre') {
      const text = node.textContent || '';
      const fence = '`'.repeat(
        Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      return '\n\n' + fence + '\n' + text.replace(/\n$/, '') + '\n' + fence + '\n\n';
    }
    if (name === 'code') {
      const text = node.textContent || '';
      const fence = '`'.repeat(
        Math.max(1, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      const padding = /^`|`$|^ .+ $/.test(text) ? ' ' : '';
      return fence + padding + text + padding + fence;
    }
    if (name === 'blockquote')
      return (
        '\n\n' +
        inner()
          .trim()
          .split('\n')
          .map((s) => '> ' + s)
          .join('\n') +
        '\n\n'
      );
    if (name === 'ul' || name === 'ol') {
      const start = Number(node.getAttribute('start')) || 1;
      return (
        '\n\n' +
        [...node.children]
          .filter((child) => child.tagName === 'LI')
          .map((child, i) => {
            const marker = name === 'ol' ? `${start + i}. ` : '- ';
            return (
              marker +
              children(child)
                .trim()
                .replace(/\n/g, '\n' + ' '.repeat(marker.length))
            );
          })
          .join('\n') +
        '\n\n'
      );
    }
    if (name === 'a') {
      const href = node.getAttribute('href');
      return href && /^(https?:|mailto:|#|\.?\.?\/|[^:]+$)/i.test(href)
        ? '[' + inner() + '](<' + href.replace(/[<>\n]/g, '') + '>)'
        : inner();
    }
    if (name === 'img') {
      const src = node.getAttribute('src');
      return src && !/^\s*(javascript|vbscript):/i.test(src)
        ? '![' +
            escape(node.getAttribute('alt') || '图片') +
            '](<' +
            src.replace(/[<>\n]/g, '') +
            '>)'
        : '';
    }
    if (name === 'hr') return '\n\n---\n\n';
    if (name === 'table') {
      const rows = [...node.querySelectorAll('tr')]
        .filter((tr) => tr.closest('table') === node)
        .map((tr) => [...tr.children].map((cell) => children(cell).trim().replace(/\n+/g, '<br>')));
      return rows.length ? '\n\n' + tableMarkdown({ rows, alignments: [] }) + '\n\n' : '';
    }
    return inner();
  }
  return children(fragment)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
