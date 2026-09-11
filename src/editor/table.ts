import { md } from '../lib/markdown';
export type TableAction = 'addRow' | 'removeRow' | 'addColumn' | 'removeColumn';
export function findTable(content: string, line: number) {
  let offset = 0,
    startLine = 1;
  for (const token of md.lexer(content)) {
    const raw = token.raw.replace(/\n+$/, '');
    const lines = raw.split('\n');
    if (token.type === 'table' && line >= startLine && line < startLine + lines.length)
      return { from: offset, to: offset + raw.length, lines, row: line - startLine };
    offset += token.raw.length;
    startLine += (token.raw.match(/\n/g) || []).length;
  }
  return null;
}
export function splitCells(row: string): string[] {
  const trimmed = row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim());
}
export function changeTable(content: string, line: number, column: number, action: TableAction) {
  const table = findTable(content, line);
  if (!table) return null;
  const rows = table.lines.map(splitCells);
  const count = rows[0].length;
  const selectedColumn = Math.max(
    0,
    Math.min(
      count - 1,
      splitCells(table.lines[table.row].slice(0, Math.max(0, column - 1))).length - 1,
    ),
  );
  if (action === 'addRow') rows.splice(Math.max(2, table.row + 1), 0, Array(count).fill(''));
  if (action === 'removeRow') {
    if (table.row < 2 || rows.length <= 3) return null;
    rows.splice(table.row, 1);
  }
  if (action === 'addColumn')
    rows.forEach((r, i) => r.splice(selectedColumn + 1, 0, i === 1 ? '---' : ''));
  if (action === 'removeColumn') {
    if (count <= 1) return null;
    rows.forEach((r) => r.splice(selectedColumn, 1));
  }
  return {
    from: table.from,
    to: table.to,
    insert: rows.map((row) => `| ${row.join(' | ')} |`).join('\n'),
  };
}
