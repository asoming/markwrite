import { beforeEach, expect, it, vi } from 'vitest';
import type { Document } from '../src/lib/types';
const native = vi.hoisted(() => ({ invoke: vi.fn(), enabled: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => native.enabled }));
import {
  cancelDiscardSession,
  defaultSettings,
  discardSessionChanges,
  flushSession,
  isDiscardedSession,
  readSession,
  writeSession,
} from '../src/lib/recovery';
const saved: Document = {
  id: 'disk',
  path: '/notes/a.md',
  name: 'a.md',
  content: 'changed',
  saved: 'original',
  bom: false,
  crlf: false,
  status: 'dirty',
  updated: 1,
};
beforeEach(() => {
  cancelDiscardSession();
  localStorage.clear();
  native.enabled = true;
  native.invoke.mockReset();
  native.invoke.mockResolvedValue(undefined);
});
it('discards file changes and unnamed drafts, including late timer and beforeunload writes', async () => {
  const docs = [saved, { ...saved, id: 'new', path: undefined, saved: '' }];
  localStorage.setItem('markwrite.session.v1', JSON.stringify({ docs }));
  await flushSession(docs, 'new', defaultSettings, '/notes');
  await discardSessionChanges(docs, 'new', defaultSettings, '/notes');
  writeSession(docs, 'new', defaultSettings, '/notes');
  await flushSession(docs, 'new', defaultSettings, '/notes');
  expect(readSession()?.docs.map((d) => d.content)).toEqual(['original']);
  expect(readSession()?.active).toBe('disk');
  expect(localStorage.getItem('markwrite.session.v1')).toBeNull();
  expect(native.invoke.mock.calls.filter((c) => c[1]?.discardPrevious)).toHaveLength(1);
  expect(docs[0].content).toBe('changed');
  expect(native.invoke.mock.calls.every((c) => c[0] === 'save_session')).toBe(true);
});
it('serializes an outstanding dirty write before purging both recovery generations', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const persisted: string[] = [];
  native.invoke.mockImplementation(async (_command, args) => {
    if (!args.discardPrevious && !persisted.length) await gate;
    persisted.push(args.json);
  });
  const docs = [saved];
  const old = flushSession(docs, 'disk', defaultSettings);
  await Promise.resolve();
  const discard = discardSessionChanges(docs, 'disk', defaultSettings);
  const late = flushSession(docs, 'disk', defaultSettings);
  release();
  await Promise.all([old, discard, late]);
  expect(JSON.parse(persisted.at(-1)!).docs[0].content).toBe('original');
});
it('does not suppress a new edit after the explicit discarded snapshot', async () => {
  const docs = [saved];
  await discardSessionChanges(docs, 'disk', defaultSettings);
  const newer = [{ ...saved, content: 'newer edit' }];
  await flushSession(newer, 'disk', defaultSettings);
  expect(readSession()?.docs[0].content).toBe('newer edit');
  expect(isDiscardedSession(newer)).toBe(false);
});
it('keeps buffers available after a failed purge and allows a normal draft retry', async () => {
  const docs = [saved];
  native.invoke.mockRejectedValueOnce(new Error('disk full'));
  await expect(discardSessionChanges(docs, 'disk', defaultSettings)).rejects.toThrow('disk full');
  expect(isDiscardedSession(docs)).toBe(false);
  await flushSession(docs, 'disk', defaultSettings);
  expect(readSession()?.docs[0].content).toBe('changed');
});
it('also discards browser-preview recovery without writing any disk file', async () => {
  native.enabled = false;
  const docs = [saved];
  await discardSessionChanges(docs, 'disk', defaultSettings);
  writeSession(docs, 'disk', defaultSettings);
  expect(readSession()?.docs[0].content).toBe('original');
  expect(native.invoke).not.toHaveBeenCalled();
});
