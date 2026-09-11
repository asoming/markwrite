import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspacePanel from '../src/components/WorkspacePanel';
import type { Document } from '../src/lib/types';
import { emptyReferences } from '../src/lib/referenceIndex';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../src/lib/platform', () => ({ desktop: true }));
vi.mock('../src/lib/useReferenceIndex', () => ({
  useReferenceIndex: () => ({ result: emptyReferences(), pending: false, error: '' }),
}));
let host: HTMLDivElement, root: Root;
const current: Document = {
  id: 'a',
  path: '/a/note.md',
  name: 'note.md',
  content: 'current',
  saved: 'current',
  bom: false,
  crlf: false,
  updated: 0,
  status: 'clean',
};
let props: Parameters<typeof WorkspacePanel>[0];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function render(next: Partial<typeof props> = {}) {
  props = { ...props, ...next };
  await act(async () => root.render(createElement(WorkspacePanel, props)));
}
async function click(node: Element) {
  await act(async () => (node as HTMLElement).click());
}
const git = (path: string) => ({
  branch: path,
  entries: [
    { path: 'one.md', index: ' ', worktree: 'M' },
    { path: 'two.md', index: ' ', worktree: 'M' },
  ],
  available: true,
  repository: true,
});
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  invoke.mockReset();
  props = {
    tab: 'history',
    root: '/a',
    current,
    docs: [current],
    entries: [],
    onTab: vi.fn(),
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onRestore: vi.fn(),
    onRefresh: vi.fn(),
    onTrashed: vi.fn(),
    onRename: vi.fn(),
    onNotify: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
describe('workspace panel request isolation', () => {
  it('keeps the most recently selected history version when same-file reads return in reverse order', async () => {
    const first = deferred<unknown>(),
      second = deferred<unknown>();
    invoke.mockImplementation((command, args) =>
      command === 'history_list'
        ? Promise.resolve([
            { id: 'one', createdAt: 1, size: 10 },
            { id: 'two', createdAt: 2, size: 10 },
          ])
        : args.id === 'one'
          ? first.promise
          : second.promise,
    );
    await render();
    const rows = host.querySelectorAll('.panel-list-item');
    await click(rows[0]);
    await click(rows[1]);
    await act(async () =>
      second.resolve({
        path: current.path,
        content: 'latest-selected',
        version: '',
        bom: false,
        crlf: false,
      }),
    );
    await act(async () =>
      first.resolve({
        path: current.path,
        content: 'stale-selected',
        version: '',
        bom: false,
        crlf: false,
      }),
    );
    expect(host.textContent).toContain('latest-selected');
    expect(host.textContent).not.toContain('stale-selected');
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === '恢复到编辑器（可撤销）')!,
    );
    expect(props.onRestore).toHaveBeenCalledWith('latest-selected');
  });
  it('clears old rows at a root switch and ignores an old diff while the new root is loading', async () => {
    const diff = deferred<string>(),
      next = deferred<unknown>();
    invoke.mockImplementation((command, args) =>
      command === 'git_status'
        ? args.path === '/a'
          ? Promise.resolve(git('a'))
          : next.promise
        : diff.promise,
    );
    await render({ tab: 'git' });
    await click(host.querySelector('.git-row button')!);
    await render({ root: '/b' });
    expect(host.querySelectorAll('.git-row')).toHaveLength(0);
    await act(async () => diff.resolve('STALE ROOT DIFF'));
    expect(host.textContent).not.toContain('STALE ROOT DIFF');
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => next.resolve(git('b')));
    expect(host.querySelectorAll('.git-row')).toHaveLength(2);
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('does not expose errors from a previous tab, including a leave-and-return to the same scope', async () => {
    const diff = deferred<string>();
    invoke.mockImplementation((command) =>
      command === 'git_status'
        ? Promise.resolve(git('a'))
        : command === 'git_diff'
          ? diff.promise
          : Promise.resolve([]),
    );
    await render({ tab: 'git' });
    await click(host.querySelector('.git-row button')!);
    await render({ tab: 'history' });
    await render({ tab: 'git' });
    await act(async () => diff.reject(new Error('OLD REQUEST FAILURE')));
    expect(host.textContent).not.toContain('OLD REQUEST FAILURE');
    expect(host.querySelector('[role="status"]')).toBeNull();
    await render({ root: undefined });
    expect(host.querySelectorAll('.git-row')).toHaveLength(0);
  });
});
it('treats cancelling the reference preview as a cancelled rename, not a panel error', async () => {
  props.onRename = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
  await render({
    tab: 'files',
    entries: [{ path: '/a/one.md', name: 'one.md', directory: false }],
  });
  await click([...host.querySelectorAll('button')].find((b) => b.textContent === '重命名')!);
  await act(async () =>
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(props.onRename).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(props.onRefresh).not.toHaveBeenCalled();
});
