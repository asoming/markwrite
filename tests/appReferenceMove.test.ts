import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiskFile, Document, Settings } from '../src/lib/types';
import { setLanguage } from '../src/lib/i18n';
import { movedReferencePath } from '../src/lib/referenceMaintenance';
import { releaseEditor } from '../src/editor/Editor';

const boundary = vi.hoisted(() => ({
  invoke: vi.fn(),
  openFiles: vi.fn(),
  parentFolder: vi.fn(),
  listFolder: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  chooseDestination: vi.fn(),
  applyMove: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...(await original<typeof import('@tauri-apps/api/core')>()),
  invoke: boundary.invoke,
  // Keep recovery in localStorage so the actual App state can be inspected.
  isTauri: () => false,
}));
vi.mock('../src/lib/platform', async (original) => ({
  ...(await original<typeof import('../src/lib/platform')>()),
  desktop: true,
  openFiles: boundary.openFiles,
  parentFolder: boundary.parentFolder,
  listFolder: boundary.listFolder,
  listFolderShallow: boundary.listFolder,
  readFile: boundary.readFile,
  writeFile: boundary.writeFile,
}));
vi.mock('../src/lib/recovery', async (original) => {
  const actual = await original<typeof import('../src/lib/recovery')>();
  return {
    ...actual,
    defaultSettings: { ...actual.defaultSettings, defaultMode: 'source', autosave: false },
  };
});
// Only substitute the worker transport: planning, disk snapshots, selected-buffer
// validation, App, the dialog, and CodeMirror/history all remain real.
vi.mock('../src/lib/referenceMove', async (original) => {
  const actual = await original<typeof import('../src/lib/referenceMove')>();
  const { analyzeReferenceChanges } = await import('../src/lib/referenceMaintenance');
  return {
    ...actual,
    prepareMove: (...args: Parameters<typeof actual.prepareMove>) =>
      actual.prepareMove(args[0], args[1], args[2], args[3], args[4], async (...input) =>
        analyzeReferenceChanges(...input),
      ),
  };
});
vi.mock('../src/Reader', () => ({
  default: ({ content }: { content: string }) => createElement('article', null, content),
}));
vi.mock('../src/lib/useDocumentStats', () => ({
  useDocumentStats: () => ({ headings: [], words: 0 }),
}));
import App from '../src/App';

type NativeChange = {
  path: string;
  nextPath: string;
  before: string;
  after: string;
  expectedVersion: string;
};
type MoveArgs = { root: string | null; from: string; to: string; changes: NativeChange[] };
let host: HTMLDivElement;
let root: Root;
let files: Map<string, DiskFile>;

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  setLanguage('zh-CN');
  files = new Map();
  for (const mock of Object.values(boundary)) mock.mockReset();
  boundary.readFile.mockImplementation(async (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    return { ...file };
  });
  boundary.writeFile.mockImplementation(async (file: DiskFile) => {
    const saved = { ...file, version: `${file.version}-saved` };
    files.set(file.path, saved);
    return saved;
  });
  boundary.parentFolder.mockImplementation(async (path: string) => ({
    path: path.slice(0, path.lastIndexOf('/')),
    entries: [],
  }));
  boundary.listFolder.mockResolvedValue([]);
  boundary.applyMove.mockImplementation(async (args: MoveArgs) => {
    const updated = args.changes.map((change) => ({
      ...files.get(change.path)!,
      path: change.nextPath,
      content: change.after,
      version: `${change.expectedVersion}-references`,
    }));
    files = new Map(
      [...files.values()].map((file) => {
        const path = movedReferencePath(file.path, args.from, args.to);
        return [path, { ...file, path }];
      }),
    );
    updated.forEach((file) => files.set(file.path, file));
    return { path: args.to, files: updated, warnings: [] };
  });
  boundary.invoke.mockImplementation(
    async (command: string, args?: MoveArgs | { path: string }) => {
      switch (command) {
        case 'initial_documents':
          return [];
        case 'document_stamp': {
          const file = files.get((args as { path: string }).path);
          if (!file) throw new Error('Missing fixture document');
          return file.version;
        }
        case 'workspace_documents':
          return [...files.values()].filter((file) =>
            file.path.startsWith((args as { path: string }).path + '/'),
          );
        case 'choose_move_destination':
          return boundary.chooseDestination(args);
        case 'apply_reference_changes':
          return boundary.applyMove(args);
        case 'watch_folder':
          return;
        default:
          throw new Error(`Unexpected native command: ${command}`);
      }
    },
  );
  mockWindows('main');
  mockIPC((command, args) => boundary.invoke(command, args), { shouldMockEvents: true });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(App)));
});
afterEach(() => {
  const ids = snapshot().docs.map((doc) => doc.id);
  act(() => root.unmount());
  clearMocks();
  ids.forEach(releaseEditor);
  host.remove();
  localStorage.clear();
  setLanguage('zh-CN');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function disk(path: string, content: string): DiskFile {
  const file = { path, content, version: `v1:${path}`, bom: true, crlf: true };
  files.set(path, file);
  return file;
}
function button(label: string, selector = 'button') {
  const found = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
    (element) => (element.getAttribute('aria-label') || element.textContent?.trim()) === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function menuAction(label: string, menu = '文件') {
  await click(button(menu, '.editing-menu-group>button'));
  const action = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
    (element) => element.querySelector('span:nth-child(2)')?.textContent === label,
  );
  expect(action, label).toBeDefined();
  await click(action!);
}
async function openDocument(file: DiskFile) {
  boundary.openFiles.mockResolvedValueOnce([{ ...file }]);
  await menuAction('打开文档…');
  await act(async () => {
    await import('../src/editor/editorRuntime');
  });
}
async function switchDocument(name: string) {
  await click(button(name, '.tabs .tab>button:first-child'));
}
function editor() {
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!);
  expect(view).not.toBeNull();
  return view!;
}
function edit(content: string) {
  act(() => {
    const view = editor();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      userEvent: 'input.paste',
      annotations: isolateHistory.of('full'),
    });
  });
}
function snapshot(): { docs: Document[]; active: string; settings: Settings } {
  act(() => window.dispatchEvent(new Event('beforeunload')));
  return JSON.parse(localStorage.getItem('markwrite.session.v1')!);
}
function documentAt(path: string) {
  const doc = snapshot().docs.find((item) => item.path === path);
  expect(doc, path).toBeDefined();
  return doc!;
}
async function rename(name: string) {
  await menuAction('重命名');
  const input = host.querySelector<HTMLInputElement>('.name-input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('确定', '.modal-footer button'));
  await act(async () => {
    await import('../src/components/RenameReferencesDialog');
  });
  expect(host.querySelector('.reference-dialog')).not.toBeNull();
}
function selection(path: string) {
  const input = [...host.querySelectorAll<HTMLInputElement>('.reference-file input')].find(
    (element) => element.getAttribute('aria-label') === `更新 ${path}`,
  );
  expect(input, path).toBeDefined();
  return input!;
}

describe('reference moves through the actual application', () => {
  it('cancels a rename without native writes and releases the dirty document save lock', async () => {
    const a = disk('/notes/a.md', '# A');
    const b = disk('/notes/b.md', '[A](a.md)');
    await openDocument(b);
    const draft = `unsaved\n${b.content}`;
    edit(draft);
    await openDocument(a);
    await rename('renamed.md');
    expect(host.querySelector('.reference-dialog-intro')?.textContent).toContain(
      '包含当前未保存的编辑',
    );
    expect(selection(b.path).checked).toBe(true);
    await click(button('取消', '.reference-dialog-footer button'));
    expect(host.querySelector('.reference-dialog')).toBeNull();
    expect(boundary.applyMove).not.toHaveBeenCalled();
    expect(documentAt(a.path).name).toBe('a.md');
    expect(documentAt(b.path)).toMatchObject({ content: draft, saved: b.content, status: 'dirty' });
    expect(host.textContent).not.toContain('Canceled');
    await switchDocument('b.md');
    await menuAction('保存');
    expect(boundary.writeFile).toHaveBeenCalledWith({ ...b, content: draft });
    expect(documentAt(b.path)).toMatchObject({ content: draft, saved: draft, status: 'clean' });
  });

  it('sends only approved native fields, applies saved versions, and preserves active and inactive undo', async () => {
    const a = disk('/notes/a.md', '# A\n[self](a.md)');
    const b = disk('/notes/b.md', '[A](a.md)');
    const c = disk('/notes/c.md', '[A](a.md)');
    await openDocument(b);
    const bDraft = `draft B\n${b.content}`;
    edit(bDraft);
    await openDocument(c);
    const cDraft = `draft C\n${c.content}`;
    edit(cDraft);
    await openDocument(a);
    const aDraft = `draft A\n${a.content}`;
    edit(aDraft);
    await rename('renamed.md');
    await click(selection(c.path));
    await click(button('确认并继续', '.reference-dialog-footer button'));
    expect(host.querySelector('.reference-dialog')).toBeNull();
    const nativeCall = boundary.invoke.mock.calls.find(
      ([command]) => command === 'apply_reference_changes',
    );
    expect(nativeCall).toBeDefined();
    const args = nativeCall![1] as MoveArgs;
    expect(args).toMatchObject({ root: '/notes', from: a.path, to: '/notes/renamed.md' });
    expect(args.changes.map((change) => change.path).sort()).toEqual([a.path, b.path]);
    for (const change of args.changes) {
      expect(Object.keys(change).sort()).toEqual([
        'after',
        'before',
        'expectedVersion',
        'nextPath',
        'path',
      ]);
      const original = change.path === a.path ? a : b;
      expect(change.before).toBe(original.content);
      expect(change.expectedVersion).toBe(original.version);
    }
    const aAfter = aDraft.replace('(a.md)', '(renamed.md)');
    const bAfter = bDraft.replace('(a.md)', '(renamed.md)');
    expect(documentAt('/notes/renamed.md')).toMatchObject({
      name: 'renamed.md',
      content: aAfter,
      saved: aAfter,
      version: `${a.version}-references`,
      status: 'clean',
      bom: true,
      crlf: true,
    });
    expect(documentAt(b.path)).toMatchObject({
      content: bAfter,
      saved: bAfter,
      version: `${b.version}-references`,
      status: 'clean',
    });
    expect(documentAt(c.path)).toMatchObject({
      content: cDraft,
      saved: c.content,
      version: c.version,
      status: 'dirty',
    });
    expect(boundary.writeFile).not.toHaveBeenCalled();
    await menuAction('撤销', '编辑');
    expect(editor().state.doc.toString()).toBe(aDraft);
    expect(documentAt('/notes/renamed.md')).toMatchObject({
      content: aDraft,
      saved: aAfter,
      version: `${a.version}-references`,
      status: 'dirty',
    });
    await switchDocument('b.md');
    expect(editor().state.doc.toString()).toBe(bAfter);
    await menuAction('撤销', '编辑');
    expect(editor().state.doc.toString()).toBe(bDraft);
    expect(documentAt(b.path)).toMatchObject({
      content: bDraft,
      saved: bAfter,
      version: `${b.version}-references`,
      status: 'dirty',
    });
  });

  it('moves an unselected dirty file to the chosen directory without saving or replacing its buffer', async () => {
    const a = disk('/notes/a.md', '[asset](image.png)');
    await openDocument(a);
    const draft = `keep unsaved\n${a.content}`;
    edit(draft);
    boundary.chooseDestination.mockResolvedValueOnce('/archive/a.md');
    await menuAction('移动到…');
    expect(boundary.chooseDestination).toHaveBeenCalledWith({ path: a.path });
    expect(selection(a.path).checked).toBe(true);
    await click(selection(a.path));
    await click(button('确认并继续', '.reference-dialog-footer button'));
    expect(boundary.applyMove).toHaveBeenCalledWith({
      root: '/notes',
      from: a.path,
      to: '/archive/a.md',
      changes: [],
    });
    expect(documentAt('/archive/a.md')).toMatchObject({
      content: draft,
      saved: a.content,
      version: a.version,
      status: 'dirty',
    });
    expect(snapshot().docs.some((doc) => doc.path === a.path)).toBe(false);
    expect(editor().state.doc.toString()).toBe(draft);
    expect(boundary.writeFile).not.toHaveBeenCalled();
    await menuAction('保存');
    expect(boundary.writeFile).toHaveBeenCalledWith({
      ...a,
      path: '/archive/a.md',
      content: draft,
    });
  });

  it('keeps the preview and unsaved state on native failure, then permits cancellation and saving', async () => {
    const a = disk('/notes/a.md', '[self](a.md)');
    await openDocument(a);
    const draft = `unsaved\n${a.content}`;
    edit(draft);
    await rename('renamed.md');
    boundary.applyMove.mockRejectedValueOnce(new Error('CONFLICT: disk changed after preview'));
    await click(button('确认并继续', '.reference-dialog-footer button'));
    expect(host.querySelector('.reference-dialog-error')?.textContent).toContain(
      'CONFLICT: disk changed',
    );
    expect(documentAt(a.path)).toMatchObject({
      content: draft,
      saved: a.content,
      version: a.version,
      status: 'dirty',
    });
    expect(snapshot().docs.some((doc) => doc.path === '/notes/renamed.md')).toBe(false);
    await click(button('取消', '.reference-dialog-footer button'));
    await menuAction('保存');
    expect(boundary.writeFile).toHaveBeenCalledWith({ ...a, content: draft });
  });
});
