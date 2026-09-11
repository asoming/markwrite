import { beforeEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
describe('workspace read cache', () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
  });
  it('shares in-flight reads and tab switches until a folder event invalidates them', async () => {
    const { workspaceDocuments, invalidateWorkspaceIndex } =
      await import('../src/lib/workspaceCache');
    let resolve!: (docs: unknown[]) => void;
    invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = workspaceDocuments('/notes'),
      second = workspaceDocuments('/notes');
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve([{ path: '/notes/a.md', content: '# one' }]);
    await Promise.all([first, second]);
    await workspaceDocuments('/notes');
    expect(invoke).toHaveBeenCalledTimes(1);
    invalidateWorkspaceIndex();
    invoke.mockResolvedValue([]);
    await workspaceDocuments('/notes');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('does not let stale completion overwrite a newer root and allows retry after failure', async () => {
    const { workspaceDocuments } = await import('../src/lib/workspaceCache');
    let resolve!: (docs: unknown[]) => void;
    invoke
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockResolvedValueOnce([{ path: '/b/n.md' }]);
    const old = workspaceDocuments('/a');
    await workspaceDocuments('/b');
    resolve([]);
    await old;
    expect((await workspaceDocuments('/b'))[0].path).toBe('/b/n.md');
    invoke.mockRejectedValueOnce(new Error('disk gone'));
    await expect(workspaceDocuments('/c')).rejects.toThrow('disk gone');
    invoke.mockResolvedValue([]);
    await workspaceDocuments('/c');
  });
});
it('keeps a newer same-root read after an older in-flight read is invalidated', async () => {
  vi.resetModules();
  invoke.mockReset();
  const { workspaceDocuments, invalidateWorkspaceIndex } =
    await import('../src/lib/workspaceCache');
  let resolve!: (files: unknown[]) => void;
  invoke
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValueOnce([{ path: '/notes/new.md' }]);
  const old = workspaceDocuments('/notes');
  invalidateWorkspaceIndex();
  await workspaceDocuments('/notes');
  resolve([{ path: '/notes/old.md' }]);
  await old;
  expect((await workspaceDocuments('/notes'))[0].path).toBe('/notes/new.md');
  expect(invoke).toHaveBeenCalledTimes(2);
});
