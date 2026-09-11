import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiskFile, FileEntry, Mode, Settings } from '../src/lib/types';
import { setLanguage } from '../src/lib/i18n';

type Folder = { path: string; entries: FileEntry[] };
const boundary = vi.hoisted(() => ({
  openFiles: vi.fn(),
  openFolder: vi.fn(),
  parentFolder: vi.fn(),
  listFolder: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock('../src/lib/platform', async (original) => ({
  ...(await original<typeof import('../src/lib/platform')>()),
  desktop: false,
  ...boundary,
}));
// App owns navigation and request ordering; editor rendering is tested separately.
// Keep the actual menu, FileNavigator, settings, and recovery code in this suite.
vi.mock('../src/editor/Editor', () => ({
  default: ({ content, mode }: { content: string; mode: Mode }) =>
    createElement('pre', { 'data-testid': 'document-buffer', 'data-mode': mode }, content),
  releaseEditor: vi.fn(),
}));
vi.mock('../src/Reader', () => ({
  default: ({ content }: { content: string }) =>
    createElement('article', { 'data-testid': 'reading-buffer' }, content),
}));
vi.mock('../src/lib/useDocumentStats', () => ({
  useDocumentStats: () => ({ headings: [], words: 0 }),
}));
import App from '../src/App';

let host: HTMLDivElement;
let root: Root;
function disk(path: string): DiskFile {
  return { path, content: `# ${path}`, version: 'v1', bom: false, crlf: false };
}
function folder(path: string, names = ['current.md', 'sibling.md']): Folder {
  return {
    path,
    entries: names.map((name) => ({ name, path: `${path}/${name}`, directory: false })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  setLanguage('zh-CN');
  for (const mock of Object.values(boundary)) mock.mockReset();
  boundary.parentFolder.mockImplementation(async (path: string) =>
    folder(path.slice(0, path.lastIndexOf('/'))),
  );
  boundary.listFolder.mockResolvedValue([]);
  boundary.readFile.mockImplementation(async (path: string) => disk(path));
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(App)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  setLanguage('zh-CN');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(label: string, selector = 'button') {
  const found = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
    (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}
async function menuAction(label: string) {
  await click(button('文件', '.editing-menu-group>button'));
  const action = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
    (element) => element.querySelector('span:nth-child(2)')?.textContent === label,
  );
  expect(action, label).toBeDefined();
  await click(action!);
}
async function openDocument(path: string) {
  boundary.openFiles.mockResolvedValueOnce([disk(path)]);
  await menuAction('打开文档…');
}
async function openWorkspace(value: Folder) {
  boundary.openFolder.mockResolvedValueOnce(value);
  await menuAction('打开文件夹…');
}
function visibleRoot() {
  return host.querySelector('.folder-heading>span')?.getAttribute('title');
}
function treeFiles() {
  return [...host.querySelectorAll<HTMLButtonElement>('.file-navigator .tree-row')].filter(
    (element) =>
      !element.closest('.navigator-recents') && !element.classList.contains('document-row'),
  );
}
function snapshot(): { active: string; root?: string; settings: Settings } {
  act(() => window.dispatchEvent(new Event('beforeunload')));
  return JSON.parse(localStorage.getItem('markwrite.session.v1')!);
}

describe('file navigation at the application boundary', () => {
  it('reveals the opened document parent, displays its recursive tree, and keeps mode controls out of the top menu', async () => {
    expect(boundary.parentFolder).not.toHaveBeenCalled();
    expect(host.querySelector('.compact-header select')).toBeNull();
    expect(host.querySelector('[role="toolbar"][aria-label="阅读与编辑工具"]')).not.toBeNull();
    expect(host.querySelector('.topbar, .breadcrumb, .breadcrumbs')).toBeNull();
    const parent = folder('/notes');
    parent.entries.push({
      name: 'nested',
      path: '/notes/nested',
      directory: true,
      children: [{ name: 'child.md', path: '/notes/nested/child.md', directory: false }],
    });
    boundary.parentFolder.mockResolvedValueOnce(parent);
    await openDocument('/notes/current.md');
    expect(boundary.parentFolder).toHaveBeenLastCalledWith('/notes/current.md');
    expect(visibleRoot()).toBe('/notes');
    expect(treeFiles().map((element) => element.title)).toContain('/notes/sibling.md');
    expect(treeFiles().map((element) => element.title)).not.toContain('/notes/nested/child.md');
    const nested = treeFiles().find((element) => element.title === '/notes/nested')!;
    expect(nested.getAttribute('aria-expanded')).toBe('false');
    await click(nested);
    expect(nested.getAttribute('aria-expanded')).toBe('true');
    expect(treeFiles().map((element) => element.title)).toContain('/notes/nested/child.md');
    expect(host.querySelector('.file-navigator [aria-current="page"]')?.getAttribute('title')).toBe(
      '/notes/current.md',
    );
    expect(host.querySelector('.compact-header')?.textContent).not.toContain('current.md');
    expect(document.title).toBe('current.md — Markwrite');
    expect(host.querySelectorAll('.file-navigator .document-row[title="current.md"]')).toHaveLength(
      0,
    );
    const child = treeFiles().find((element) => element.title === '/notes/nested/child.md')!;
    await click(child);
    expect(boundary.readFile).toHaveBeenCalledWith('/notes/nested/child.md');
    expect(boundary.parentFolder).toHaveBeenLastCalledWith('/notes/nested/child.md');
    expect(visibleRoot()).toBe('/notes/nested');
  });

  it('follows each active document when opening files or switching existing tabs', async () => {
    await openDocument('/first/current.md');
    await openDocument('/second/next.md');
    expect(visibleRoot()).toBe('/second');
    expect(treeFiles().map((element) => element.title)).not.toContain('/first/sibling.md');
    await click(button('current.md', '.tabs .tab>button:first-child'));
    expect(boundary.parentFolder).toHaveBeenLastCalledWith('/first/current.md');
    expect(visibleRoot()).toBe('/first');
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(
      '# /first/current.md',
    );
  });

  it('switches modes and enters and exits focus from the floating controls without changing the document', async () => {
    await openDocument('/notes/current.md');
    const original = disk('/notes/current.md').content;
    expect(host.querySelector('.sidebar-brand')?.textContent).toBe('墨页Markwrite');
    await click(button('源码模式'));
    expect(host.querySelector('[data-testid="document-buffer"]')?.getAttribute('data-mode')).toBe(
      'source',
    );
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(original);
    await click(button('进入专注模式'));
    expect(host.querySelector('.compact-header')).toBeNull();
    expect(host.querySelector('.statusbar')).toBeNull();
    await click(button('阅读模式'));
    expect(host.querySelector('[data-testid="reading-buffer"]')?.textContent).toBe(original);
    await click(button('退出专注模式'));
    expect(host.querySelector('.statusbar')).not.toBeNull();
    await click(button('进入专注模式'));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('.compact-header')).not.toBeNull();
    expect(host.querySelector('[data-testid="reading-buffer"]')?.textContent).toBe(original);
    await act(async () => setLanguage('en'));
    expect(host.querySelector('.sidebar-brand')?.textContent).toBe('墨页Markwrite');
    expect(button('Reading mode').getAttribute('aria-pressed')).toBe('true');
    await click(button('Help', '[role="menuitem"]'));
    await click(button('About Markwrite', '[role="menuitem"]'));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Write with visual formatting',
    );
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('通过菜单设置格式');
    expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('墨页');
  });

  it('pins an explicitly selected workspace, refreshes that folder, and resumes following with the pin control', async () => {
    await openDocument('/first/current.md');
    await openWorkspace(folder('/project', ['project.md']));
    expect(snapshot()).toMatchObject({ root: '/project', settings: { followFileParent: false } });
    expect(button('跟随当前文件')).toBeDefined();
    const followed = boundary.parentFolder.mock.calls.length;
    await openDocument('/second/next.md');
    expect(boundary.parentFolder).toHaveBeenCalledTimes(followed);
    expect(visibleRoot()).toBe('/project');
    expect(treeFiles().map((element) => element.title)).toContain('/project/project.md');
    boundary.listFolder.mockResolvedValueOnce(folder('/project', ['refreshed.md']).entries);
    await click(button('刷新文件树'));
    expect(boundary.listFolder).toHaveBeenCalledWith('/project');
    expect(treeFiles().map((element) => element.title)).toContain('/project/refreshed.md');
    await click(button('跟随当前文件'));
    expect(boundary.parentFolder).toHaveBeenLastCalledWith('/second/next.md');
    expect(visibleRoot()).toBe('/second');
    expect(snapshot().settings.followFileParent).toBe(true);
    await click(button('固定此文件夹'));
    await openDocument('/third/last.md');
    expect(visibleRoot()).toBe('/second');
    expect(snapshot().settings.followFileParent).toBe(false);
  });

  it('ignores an older parent request that finishes after the newly active file', async () => {
    const first = deferred<Folder>();
    const second = deferred<Folder>();
    boundary.parentFolder.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await openDocument('/first/current.md');
    await openDocument('/second/next.md');
    await act(async () => second.resolve(folder('/second', ['next.md'])));
    expect(visibleRoot()).toBe('/second');
    await act(async () => first.resolve(folder('/first', ['current.md'])));
    expect(visibleRoot()).toBe('/second');
    expect(treeFiles().map((element) => element.title)).toEqual(['/second/next.md']);
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
    expect(snapshot().root).toBe('/second');
  });

  it('keeps a manually pinned folder when an earlier automatic request finishes late', async () => {
    const pending = deferred<Folder>();
    boundary.parentFolder.mockReturnValueOnce(pending.promise);
    await openDocument('/first/current.md');
    await openWorkspace(folder('/pinned', ['project.md']));
    await act(async () => pending.resolve(folder('/first', ['current.md'])));
    expect(visibleRoot()).toBe('/pinned');
    expect(treeFiles().map((element) => element.title)).toEqual(['/pinned/project.md']);
    expect(snapshot()).toMatchObject({ root: '/pinned', settings: { followFileParent: false } });
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
  });

  it('does not show a stale error after navigation has already succeeded', async () => {
    const pending = deferred<Folder>();
    boundary.parentFolder.mockReturnValueOnce(pending.promise);
    await openDocument('/first/current.md');
    await openDocument('/second/next.md');
    await act(async () => pending.reject(new Error('stale folder read error')));
    expect(visibleRoot()).toBe('/second');
    expect(host.querySelector('.file-navigator')?.textContent).not.toContain(
      'stale folder read error',
    );
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
  });

  it('discards a pinned-folder refresh that completes after another folder was selected', async () => {
    await openWorkspace(folder('/first-project', ['first.md']));
    const pending = deferred<FileEntry[]>();
    boundary.listFolder.mockReturnValueOnce(pending.promise);
    await click(button('刷新文件树'));
    expect(boundary.listFolder).toHaveBeenCalledWith('/first-project');
    await openWorkspace(folder('/second-project', ['second.md']));
    await act(async () => pending.resolve(folder('/first-project', ['stale.md']).entries));
    expect(visibleRoot()).toBe('/second-project');
    expect(treeFiles().map((element) => element.title)).toEqual(['/second-project/second.md']);
    expect(snapshot()).toMatchObject({
      root: '/second-project',
      settings: { followFileParent: false },
    });
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
  });

  it('discards a pinned-folder refresh after resuming automatic following', async () => {
    await openDocument('/notes/current.md');
    await openWorkspace(folder('/project', ['project.md']));
    const pending = deferred<FileEntry[]>();
    boundary.listFolder.mockReturnValueOnce(pending.promise);
    await click(button('刷新文件树'));
    await click(button('跟随当前文件'));
    expect(visibleRoot()).toBe('/notes');
    await act(async () => pending.resolve(folder('/project', ['stale.md']).entries));
    expect(visibleRoot()).toBe('/notes');
    expect(treeFiles().map((element) => element.title)).toEqual([
      '/notes/current.md',
      '/notes/sibling.md',
    ]);
    expect(snapshot().settings.followFileParent).toBe(true);
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
  });

  it('ends automatic loading immediately when the user pins the visible folder', async () => {
    await openDocument('/first/current.md');
    const pending = deferred<Folder>();
    boundary.parentFolder.mockReturnValueOnce(pending.promise);
    await openDocument('/second/next.md');
    expect(host.querySelector('.navigator-note[role="status"]')?.textContent).toContain(
      '正在读取文件夹',
    );
    await click(button('固定此文件夹'));
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
    expect(visibleRoot()).toBe('/first');
    expect(snapshot().settings.followFileParent).toBe(false);
    await act(async () => pending.resolve(folder('/second', ['next.md'])));
    expect(visibleRoot()).toBe('/first');
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
  });

  it('ends automatic loading when switching to a draft and ignores the late result', async () => {
    const draft = host.querySelector<HTMLButtonElement>('.file-navigator .document-row')!;
    const draftName = draft.textContent;
    const pending = deferred<Folder>();
    boundary.parentFolder.mockReturnValueOnce(pending.promise);
    await openDocument('/notes/current.md');
    expect(host.querySelector('.navigator-note[role="status"]')?.textContent).toContain(
      '正在读取文件夹',
    );
    const draftButton = [
      ...host.querySelectorAll<HTMLButtonElement>('.file-navigator .document-row'),
    ].find((element) => element.textContent === draftName)!;
    await click(draftButton);
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
    expect(visibleRoot()).toBeNull();
    await act(async () => pending.resolve(folder('/notes')));
    expect(visibleRoot()).toBeNull();
    expect(host.querySelector('.navigator-note[role="status"]')).toBeNull();
    expect(snapshot().settings.followFileParent).toBe(true);
  });

  it('keeps the latest tree selection active when an earlier file read finishes later', async () => {
    await openWorkspace(folder('/project', ['a.md', 'b.md']));
    const first = deferred<DiskFile>();
    const second = deferred<DiskFile>();
    boundary.readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await click(treeFiles().find((element) => element.title === '/project/a.md')!);
    await click(treeFiles().find((element) => element.title === '/project/b.md')!);
    expect(boundary.readFile.mock.calls.map((call) => call[0])).toEqual([
      '/project/a.md',
      '/project/b.md',
    ]);
    await act(async () => second.resolve(disk('/project/b.md')));
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(
      '# /project/b.md',
    );
    const latest = snapshot();
    await act(async () => first.resolve(disk('/project/a.md')));
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(
      '# /project/b.md',
    );
    expect(document.title).toBe('b.md — Markwrite');
    expect(snapshot()).toMatchObject({
      active: latest.active,
      root: '/project',
    });
    expect(host.querySelector('.file-navigator [aria-current="page"]')?.getAttribute('title')).toBe(
      '/project/b.md',
    );
  });

  it('keeps an existing draft active when a previously clicked file finishes loading', async () => {
    await openWorkspace(folder('/project', ['a.md']));
    const before = snapshot();
    const draftContent = host.querySelector('[data-testid="document-buffer"]')?.textContent;
    const pending = deferred<DiskFile>();
    boundary.readFile.mockReturnValueOnce(pending.promise);
    await click(treeFiles().find((element) => element.title === '/project/a.md')!);
    const draft = host.querySelector<HTMLButtonElement>('.file-navigator .document-row')!;
    await click(draft);
    await act(async () => pending.resolve(disk('/project/a.md')));
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(draftContent);
    expect(snapshot()).toMatchObject({
      active: before.active,
      root: '/project',
    });
    expect(host.querySelector('.file-navigator [aria-current="page"]')).toBeNull();
    expect(host.querySelector('.file-navigator .document-row.selected')).not.toBeNull();
  });
});
