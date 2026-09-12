import { diffChars, diffLines } from 'diff';
export type Fragment = { text: string; changed: boolean };
export type CompareRow = {
  left?: string;
  right?: string;
  leftLine?: number;
  rightLine?: number;
  kind: 'same' | 'changed';
  hunk?: number;
  leftParts?: Fragment[];
  rightParts?: Fragment[];
};
export type Comparison = {
  rows: CompareRow[];
  hunks: number;
  added: number;
  removed: number;
  error?: string;
};
/** Runs in a worker. Limits are explicit: never silently truncate a comparison. */
export function compareText(before: string, after: string): Comparison {
  const empty = { rows: [], hunks: 0, added: 0, removed: 0 };
  if (
    before.length + after.length > 2_000_000 ||
    before.split('\n').length + after.split('\n').length > 12_000
  )
    return { ...empty, error: 'size' };
  const changes = diffLines(before, after, { timeout: 800, maxEditLength: 12000 });
  if (!changes) return { ...empty, error: 'timeout' };
  const rows: CompareRow[] = [];
  let left = 1,
    right = 1,
    hunks = 0,
    added = 0,
    removed = 0;
  const lines = (value: string) => value.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (let i = 0; i < changes.length; i++) {
    const part = changes[i];
    if (!part.added && !part.removed) {
      for (const line of lines(part.value))
        rows.push({ left: line, right: line, leftLine: left++, rightLine: right++, kind: 'same' });
      continue;
    }
    const old: string[] = [],
      next: string[] = [];
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      (changes[i].removed ? old : next).push(...lines(changes[i].value));
      i++;
    }
    i--;
    removed += old.length;
    added += next.length;
    for (let n = 0; n < Math.max(old.length, next.length); n++) {
      const a = old[n],
        b = next[n];
      const row: CompareRow = {
        left: a,
        right: b,
        leftLine: a === undefined ? undefined : left++,
        rightLine: b === undefined ? undefined : right++,
        kind: 'changed',
        hunk: hunks,
      };
      if (a !== undefined && b !== undefined && a.length + b.length <= 4000) {
        const words = diffChars(a, b, { timeout: 15 });
        if (words) {
          row.leftParts = words
            .filter((p) => !p.added)
            .map((p) => ({ text: p.value, changed: !!p.removed }));
          row.rightParts = words
            .filter((p) => !p.removed)
            .map((p) => ({ text: p.value, changed: !!p.added }));
        }
      }
      rows.push(row);
    }
    hunks++;
  }
  return { rows, hunks, added, removed };
}
export type VisibleRow = { row: CompareRow; index: number } | { from: number; to: number };
export function comparisonContext(rows: CompareRow[], expanded: Set<number>): VisibleRow[] {
  const visible: VisibleRow[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'same') {
      visible.push({ row: rows[i], index: i++ });
      continue;
    }
    let end = i;
    while (end < rows.length && rows[end].kind === 'same') end++;
    const first = i === 0 ? i : i + 3,
      last = end === rows.length ? end : end - 3;
    if (last - first > 3 && !expanded.has(first)) {
      for (; i < first; i++) visible.push({ row: rows[i], index: i });
      visible.push({ from: first, to: last });
      i = last;
    }
    for (; i < end; i++) visible.push({ row: rows[i], index: i });
  }
  return visible;
}
