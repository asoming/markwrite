import { beforeEach, expect, it, vi } from 'vitest';
import type { Document } from '../src/lib/types';
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));
const doc = (id: string, dirty = false): Document => ({
  id,
  name: `${id}.md`,
  path: `/notes/${id}.md`,
  content: dirty ? 'unsaved' : 'disk',
  saved: 'disk',
  bom: false,
  crlf: false,
  status: dirty ? 'dirty' : 'clean',
  updated: 1,
});
beforeEach(() => {
  vi.resetModules();
  native.invoke.mockReset();
  localStorage.clear();
});
it('starts without old clean tabs or root and preserves unsaved work through repeated launches', async () => {
  let persisted = JSON.stringify({
    docs: [doc('clean'), doc('dirty', true)],
    active: 'clean',
    root: '/old',
    settings: { language: 'en', shortcuts: { 'app:open': 'Mod+Shift+O' } },
  });
  native.invoke.mockImplementation(async (name, args) => {
    if (name === 'initial_documents') return [];
    if (name === 'window_context') return {};
    if (name === 'load_session') return persisted;
    if (name === 'save_session') persisted = args.json;
  });
  for (let i = 0; i < 3; i++) {
    const session = await import('../src/lib/recovery');
    await session.prepareSession();
    expect(session.readSession()?.docs).toEqual([]);
    expect(session.readSession()?.root).toBeUndefined();
    expect(session.pendingDrafts().map((d) => d.id)).toEqual(['dirty']);
    expect(session.readSession()?.settings.language).toBe('en');
    await session.flushSession([doc('current')], 'current', session.readSession()!.settings);
    vi.resetModules();
  }
});
it('cold file open paints only the requested file, archives old drafts, and transfers recovery ownership', async () => {
  native.invoke.mockImplementation(async (name) => {
    if (name === 'initial_documents')
      return [{ path: '/notes/requested.md', content: 'requested' }];
    if (name === 'window_context') return {};
    if (name === 'load_session') return JSON.stringify({ docs: [doc('old'), doc('draft', true)] });
  });
  const session = await import('../src/lib/recovery');
  await session.prepareSession();
  expect(session.readSession()?.docs.map((d) => d.path)).toEqual(['/notes/requested.md']);
  expect(() => session.writeSession([], '', session.defaultSettings)).toThrow('Recovery');
  session.archiveSession(await session.loadDeferredSession());
  session.finishRecovery();
  expect(session.pendingDrafts().map((d) => d.id)).toEqual(['draft']);
  const recovered = session.pendingDrafts()[0];
  session.forgetPendingDraft(recovered.id);
  await session.flushSession([recovered], recovered.id, session.defaultSettings);
  expect(session.readSession()?.pendingDocs).toEqual([]);
  expect(session.readSession()?.docs[0].content).toBe('unsaved');
});
it('still honors the explicit independent-window restore command', async () => {
  native.invoke.mockImplementation(async (name) => {
    if (name === 'initial_documents') return [];
    if (name === 'window_context') return { restore: true };
    if (name === 'load_session')
      return JSON.stringify({ docs: [doc('explicit', true)], active: 'explicit' });
  });
  const session = await import('../src/lib/recovery');
  await session.prepareSession();
  expect(session.readSession()?.docs[0].content).toBe('unsaved');
  expect(session.pendingDrafts()).toEqual([]);
});
