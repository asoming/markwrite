import { it, expect } from 'vitest';
import { splitMergeConflicts, mergeResult } from '../src/lib/mergeConflicts';
it('resolves each hunk while preserving surrounding Markdown and diff3 base', () => {
  const source =
    '# Keep\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> branch\n\nUntouched\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> next\n';
  const parts = splitMergeConflicts(source);
  expect(mergeResult(parts, { 1: 'ours' })).toBeNull();
  expect(mergeResult(parts, { 1: 'base', 3: 'both' })).toBe('# Keep\nold\n\nUntouched\nx\ny\n');
});
it('retains malformed markers and Markdown underline syntax for explicit review', () => {
  const source = 'Heading\n=======\n\n<<<<<<< HEAD\nunterminated';
  expect(mergeResult(splitMergeConflicts(source), {})).toBe(source);
});
