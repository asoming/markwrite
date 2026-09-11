import { isolateHistory, redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { renderMarkdown } from '../lib/markdown';
import { t } from '../lib/i18n';

export type DirectBlockController = {
  update(raw: string, path: string, position: number): boolean;
  destroy(): void;
};
type Cell = { from: number; to: number; value: string };

/** Keep the original spacing and every other cell intact when changing one cell. */
export function tableCellRanges(raw: string): Cell[][] {
  let offset = 0;
  return raw.split('\n').flatMap((line, row) => {
    const start = offset;
    offset += line.length + 1;
    if (row === 1) return [];
    const pipes: number[] = [];
    for (let index = 0; index < line.length; index++) {
      if (line[index] !== '|') continue;
      let slashes = 0;
      for (let previous = index - 1; previous >= 0 && line[previous] === '\\'; previous--)
        slashes++;
      if (slashes % 2 === 0) pipes.push(index);
    }
    let left = 0;
    let right = line.length;
    if (pipes.length && !line.slice(0, pipes[0]).trim()) left = pipes.shift()! + 1;
    if (pipes.length && !line.slice(pipes[pipes.length - 1] + 1).trim()) right = pipes.pop()!;
    const ranges: Cell[] = [];
    for (const end of [...pipes, right]) {
      const text = line.slice(left, end);
      const leading = text.match(/^\s*/)?.[0].length || 0;
      const trailing = text.match(/\s*$/)?.[0].length || 0;
      const from = Math.min(end, left + leading);
      const to = Math.max(from, end - trailing);
      ranges.push({ from: start + from, to: start + to, value: line.slice(from, to) });
      left = end + 1;
    }
    return [ranges];
  });
}

export function tableCellText(raw: string): string {
  return raw.replace(/\\\|/g, '|').replace(/<br\s*\/?\s*>/gi, '\n');
}

export function escapeTableCell(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return normalized
    .replace(/\|/g, (_pipe, index: number) => {
      let slashes = 0;
      for (let previous = index - 1; previous >= 0 && normalized[previous] === '\\'; previous--)
        slashes++;
      return slashes % 2 === 0 ? '\\|' : '|';
    })
    .replace(/\n/g, '<br>');
}

export function attachDirectTable(
  view: EditorView,
  root: HTMLElement,
  initialRaw: string,
  initialPosition: number,
): DirectBlockController {
  let raw = initialRaw;
  let position = initialPosition;
  let pending: string | null = null;
  let disposed = false;
  let active: {
    row: number;
    column: number;
    input: HTMLTextAreaElement;
    composing: boolean;
    first: boolean;
  } | null = null;
  const table = root.querySelector('table')!;
  const cells = [...table.rows].map((row) => [...row.cells]);

  function announceComposition(value: boolean) {
    view.dom.dispatchEvent(new CustomEvent('markwrite:widget-composition', { detail: value }));
  }
  function commit() {
    if (!active || active.composing || disposed) return;
    if (view.state.doc.sliceString(position, position + raw.length) !== raw) return;
    const cell = tableCellRanges(raw)[active.row]?.[active.column];
    if (!cell) return;
    let insert = escapeTableCell(active.input.value);
    // A trailing escape must not consume a delimiter in tightly spaced tables.
    if (/(?<!\\)(?:\\\\)*\\$/.test(insert) && raw[cell.to] === '|') insert += ' ';
    if (insert === cell.value) return;
    pending = raw.slice(0, cell.from) + insert + raw.slice(cell.to);
    const first = active.first;
    active.first = false;
    view.dispatch({
      changes: { from: position + cell.from, to: position + cell.to, insert },
      userEvent: 'input.type',
      ...(first ? { annotations: isolateHistory.of('before') } : {}),
    });
  }
  function finish(focusEditor = false) {
    if (!active) return;
    const current = active;
    if (current.composing) {
      current.composing = false;
      announceComposition(false);
    }
    commit();
    active = null;
    if (disposed || !current.input.isConnected) return;
    const cell = cells[current.row][current.column];
    const source = tableCellRanges(raw)[current.row]?.[current.column]?.value || '';
    const parsed = document.createElement('template');
    // Render just this cell; its wrappers are editor UI and never saved in Markdown.
    parsed.innerHTML = renderMarkdown(`| cell |\n| --- |\n| ${source} |`);
    cell.replaceChildren(...Array.from(parsed.content.querySelector('td')?.childNodes || []));
    cell.classList.remove('is-editing');
    view.dispatch({ annotations: isolateHistory.of('after') });
    view.requestMeasure();
    if (focusEditor) view.focus();
  }
  function begin(row: number, column: number) {
    if (disposed || !cells[row]?.[column]) return;
    if (active?.row === row && active.column === column) return;
    finish();
    const source = tableCellRanges(raw)[row]?.[column];
    if (!source) return;
    const cell = cells[row][column];
    const input = document.createElement('textarea');
    input.className = 'direct-table-input';
    input.rows = Math.max(1, tableCellText(source.value).split('\n').length);
    input.value = tableCellText(source.value);
    input.setAttribute(
      'aria-label',
      t('表格第 {0} 行第 {1} 列', 'Table row {0}, column {1}', [row + 1, column + 1]),
    );
    input.spellcheck = false;
    active = { row, column, input, composing: false, first: true };
    cell.classList.add('is-editing');
    cell.replaceChildren(input);
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('compositionstart', (event) => {
      event.stopPropagation();
      if (active) active.composing = true;
      announceComposition(true);
    });
    input.addEventListener('compositionend', (event) => {
      event.stopPropagation();
      if (active) active.composing = false;
      commit();
      announceComposition(false);
    });
    input.addEventListener('input', () => {
      input.rows = Math.max(1, input.value.split('\n').length);
      commit();
      view.requestMeasure();
    });
    input.addEventListener('paste', (event) => {
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain');
      if (text == null) return;
      event.preventDefault();
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || active?.composing) {
        event.stopPropagation();
        return;
      }
      // Application commands such as Save must still reach the window shortcut handler.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== 'z') return;
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        finish();
        (event.shiftKey ? redo : undo)(view);
        view.focus();
      } else if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const width = cells[row].length;
        const next = row * width + column + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < cells.length * width) begin(Math.floor(next / width), next % width);
        else finish(true);
      }
    });
    input.addEventListener('blur', () => finish());
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    view.requestMeasure();
  }
  cells.forEach((row, rowIndex) =>
    row.forEach((cell, column) => {
      cell.tabIndex = 0;
      cell.classList.add('direct-table-cell');
      cell.title = t('点击编辑单元格', 'Click to edit cell');
      cell.addEventListener('mousedown', (event) => {
        if ((event.target as HTMLElement).closest('a,button,textarea')) return;
        event.preventDefault();
        event.stopPropagation();
        begin(rowIndex, column);
      });
      cell.addEventListener('keydown', (event) => {
        if (event.target !== cell || !['Enter', 'F2'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        begin(rowIndex, column);
      });
    }),
  );
  return {
    update(nextRaw, _path, nextPosition) {
      if (nextRaw !== raw && nextRaw !== pending) return false;
      raw = nextRaw;
      position = nextPosition;
      pending = null;
      return true;
    },
    destroy() {
      disposed = true;
      if (active?.composing) announceComposition(false);
      active = null;
    },
  };
}
