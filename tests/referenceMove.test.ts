import { expect, it, vi } from 'vitest';
import { prepareMove, selectedMoveChanges } from '../src/lib/referenceMove';
import { analyzeReferenceChanges } from '../src/lib/referenceMaintenance';
import type { Document, DiskFile } from '../src/lib/types';
const a = { path: '/notes/a.md', content: 'A', version: 'a1', bom: false, crlf: false };
const b = { path: '/notes/b.md', content: '[A](a.md)', version: 'b1', bom: true, crlf: true };
const doc = (f: DiskFile): Document => ({
  ...f,
  id: f.path,
  name: f.path.split('/').at(-1)!,
  saved: f.content,
  status: 'clean',
  updated: 1,
});
const analyze = async (...args: Parameters<typeof analyzeReferenceChanges>) =>
  analyzeReferenceChanges(...args);
it('previews unsaved links, checks disk version, and sends the confirmed edit with disk before', async () => {
  const buffer = { ...doc(b), content: 'draft\n[A](a.md)', status: 'dirty' as const };
  const read = vi.fn(async () => b);
  const plan = await prepareMove(a.path, '/notes/new.md', [a, b], [doc(a), buffer], read, analyze);
  expect(plan.changes[0].before).toBe(buffer.content);
  expect(selectedMoveChanges(plan, [b.path], [doc(a), buffer])).toMatchObject([
    { before: b.content, after: 'draft\n[A](new.md)', expectedVersion: 'b1', nextPath: b.path },
  ]);
  expect(selectedMoveChanges(plan, [], [doc(a), buffer])).toEqual([]);
  expect(Object.keys(selectedMoveChanges(plan, [b.path], [doc(a), buffer])[0]).sort()).toEqual([
    'after',
    'before',
    'expectedVersion',
    'nextPath',
    'path',
  ]);
  expect(() =>
    selectedMoveChanges(plan, [b.path], [doc(a), { ...buffer, content: 'changed' }]),
  ).toThrow(/CONFLICT/);
});
it('does not approve overwritten or newly opened buffers and stale disk references', async () => {
  await expect(
    prepareMove(
      a.path,
      '/notes/new.md',
      [a, b],
      [{ ...doc(b), version: 'old' }],
      async () => b,
      analyze,
    ),
  ).rejects.toThrow(/CONFLICT/);
  await expect(
    prepareMove(
      a.path,
      '/notes/new.md',
      [a, b],
      [],
      async () => ({ ...b, content: 'External' }),
      analyze,
    ),
  ).rejects.toThrow(/CONFLICT/);
  const plan = await prepareMove(a.path, '/notes/new.md', [a, b], [], async () => b, analyze);
  expect(() => selectedMoveChanges(plan, [b.path], [doc(b)])).toThrow(/CONFLICT/);
});
