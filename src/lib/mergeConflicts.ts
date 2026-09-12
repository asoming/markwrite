export type MergePart = { text: string } | { ours: string; base?: string; theirs: string };
/** Parse ordinary and diff3 conflict markers, preserving all non-conflict text verbatim. */
export function splitMergeConflicts(source: string): MergePart[] {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  const parts: MergePart[] = [];
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    if (!/^<<<<<<<(?: |\r?\n|$)/.test(lines[i])) {
      text += lines[i];
      continue;
    }
    if (text) {
      parts.push({ text });
      text = '';
    }
    const start = i;
    let ours = '',
      base: string | undefined,
      theirs = '';
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    let closed = false;
    while (++i < lines.length) {
      if (/^\|{7}(?: |\r?\n|$)/.test(lines[i]) && section === 'ours') {
        section = 'base';
        base = '';
      } else if (/^={7}\r?\n?$/.test(lines[i]) && section !== 'theirs') section = 'theirs';
      else if (/^>{7}(?: |\r?\n|$)/.test(lines[i]) && section === 'theirs') {
        closed = true;
        break;
      } else if (section === 'ours') ours += lines[i];
      else if (section === 'base') base += lines[i];
      else theirs += lines[i];
    }
    if (!closed) {
      parts.push({ text: lines.slice(start).join('') });
      break;
    }
    parts.push({ ours, theirs, base });
  }
  if (text) parts.push({ text });
  return parts;
}
export function mergeResult(
  parts: MergePart[],
  choices: Record<number, 'ours' | 'theirs' | 'both' | 'base'>,
): string | null {
  if (parts.some((part, i) => !('text' in part) && !choices[i])) return null;
  return parts
    .map((part, i) =>
      'text' in part
        ? part.text
        : choices[i] === 'both'
          ? part.ours + part.theirs
          : choices[i] === 'base'
            ? part.base || ''
            : part[choices[i] as 'ours' | 'theirs'],
    )
    .join('');
}
