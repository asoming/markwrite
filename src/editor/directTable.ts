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

export type TableReorder = { axis: 'row' | 'column'; from: number; to: number };
/** Structural edits are explicit, bounded and confined to this table. Header stays fixed when sorting. */
export function transformTable(
  raw: string,
  operation:
    | TableReorder
    | {
        row: number;
        column: number;
        paste: string;
      }
    | { sort: number; descending: boolean },
): string {
  const rows = tableCellRanges(raw).map((row) => row.map((cell) => cell.value));
  const separators =
    tableCellRanges(`${raw.split('\n')[1]}\nignored`)[0]?.map((cell) => cell.value) || [];
  let width = Math.max(...rows.map((row) => row.length));
  if ('paste' in operation) {
    const values = operation.paste
      .replace(/\r\n?/g, '\n')
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.split('\t'));
    width = Math.max(width, operation.column + Math.max(...values.map((row) => row.length)));
    if (width * Math.max(rows.length, operation.row + values.length) > 10_000)
      throw new Error(t('表格最多支持 10000 个单元格', 'Tables support up to 10000 cells'));
    values.forEach((row, r) =>
      row.forEach((value, c) => {
        while (rows.length <= operation.row + r) rows.push([]);
        rows[operation.row + r][operation.column + c] = escapeTableCell(value);
      }),
    );
  } else if ('sort' in operation) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const body = rows
      .slice(1)
      .sort(
        (a, b) =>
          collator.compare(
            tableCellText(a[operation.sort] || ''),
            tableCellText(b[operation.sort] || ''),
          ) * (operation.descending ? -1 : 1),
      );
    rows.splice(1, rows.length - 1, ...body);
  } else {
    const { axis, from, to } = operation;
    const size = axis === 'row' ? rows.length : width;
    if (
      from < (axis === 'row' ? 1 : 0) ||
      to < (axis === 'row' ? 1 : 0) ||
      from >= size ||
      to >= size
    )
      return raw;
    const move = (values: string[]) => values.splice(to, 0, values.splice(from, 1)[0] || '');
    if (axis === 'row') rows.splice(to, 0, rows.splice(from, 1)[0]);
    else {
      rows.forEach(move);
      move(separators);
    }
  }
  const format = (row: string[], separator = false) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] || (separator ? '---' : '')).join(' | ')} |`;
  return [
    format(rows[0]),
    format(separators, true),
    ...rows.slice(1).map((row) => format(row)),
  ].join('\n');
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
  let selectedCell = { row: 1, column: 0 };
  let dragging: { axis: 'row' | 'column'; from: number } | null = null;
  const tools = root.querySelector('.live-block-tools') || root;
  function structural(operation: Parameters<typeof transformTable>[1]) {
    if (active?.composing || disposed) return;
    finish();
    if (view.state.doc.sliceString(position, position + raw.length) !== raw) return;
    try {
      const insert = transformTable(raw, operation);
      if (insert === raw) return;
      view.dispatch({
        changes: { from: position, to: position + raw.length, insert },
        userEvent: 'input.format',
        annotations: isolateHistory.of('full'),
      });
      view.focus();
    } catch (error) {
      notice.textContent = String(error instanceof Error ? error.message : error);
    }
  }
  function tool(label: string, symbol: string, run: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = symbol;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    tools.append(button);
    return button;
  }
  tool(t('上移当前行', 'Move row up'), '↑', () =>
    structural({ axis: 'row', from: selectedCell.row, to: selectedCell.row - 1 }),
  );
  tool(t('下移当前行', 'Move row down'), '↓', () =>
    structural({ axis: 'row', from: selectedCell.row, to: selectedCell.row + 1 }),
  );
  tool(t('左移当前列', 'Move column left'), '←', () =>
    structural({ axis: 'column', from: selectedCell.column, to: selectedCell.column - 1 }),
  );
  tool(t('右移当前列', 'Move column right'), '→', () =>
    structural({ axis: 'column', from: selectedCell.column, to: selectedCell.column + 1 }),
  );
  tool(t('按当前列升序', 'Sort column ascending'), 'A↓', () =>
    structural({ sort: selectedCell.column, descending: false }),
  );
  tool(t('按当前列降序', 'Sort column descending'), 'Z↓', () =>
    structural({ sort: selectedCell.column, descending: true }),
  );
  for (const axis of ['row', 'column'] as const) {
    const handle = tool(
      axis === 'row'
        ? t('拖动当前行到目标单元格', 'Drag row onto a target cell')
        : t('拖动当前列到目标单元格', 'Drag column onto a target cell'),
      axis === 'row' ? '↕' : '↔',
      () => {},
    );
    handle.draggable = true;
    handle.addEventListener('dragstart', (event) => {
      if (active?.composing) {
        event.preventDefault();
        return;
      }
      finish();
      dragging = { axis, from: axis === 'row' ? selectedCell.row : selectedCell.column };
      event.dataTransfer?.setData('application/x-markwrite-table', axis);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    handle.addEventListener('dragend', () => {
      dragging = null;
    });
  }
  const notice = document.createElement('span');
  notice.setAttribute('role', 'status');
  notice.className = 'direct-table-notice';
  tools.append(notice);

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
    selectedCell = { row, column };
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
      if (text.includes('\t')) {
        structural({ row, column, paste: text });
        return;
      }
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
      cell.addEventListener('dragover', (event) => {
        if (dragging) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      cell.addEventListener('drop', (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
        const move = dragging;
        dragging = null;
        structural({ ...move, to: move.axis === 'row' ? rowIndex : column });
      });
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
