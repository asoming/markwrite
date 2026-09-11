import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ desktop: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => boundary.desktop,
  invoke: boundary.invoke,
}));
type PickerWindow = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: () => Promise<FileSystemFileHandle[]>;
};
const browser = window as PickerWindow;
beforeEach(() => {
  vi.resetModules();
  boundary.desktop = false;
  boundary.invoke.mockReset();
  delete browser.showDirectoryPicker;
  delete browser.showOpenFilePicker;
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  delete browser.showDirectoryPicker;
  delete browser.showOpenFilePicker;
  vi.unstubAllGlobals();
});

function file(name: string): FileSystemFileHandle {
  const handle = {
    name,
    kind: 'file',
    isSameEntry: async (other: FileSystemHandle) => other === handle,
    getFile: async () => ({ arrayBuffer: async () => new TextEncoder().encode('# 文档').buffer }),
  };
  return handle as unknown as FileSystemFileHandle;
}
function directory(name: string, items: FileSystemHandle[]): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory',
    async *entries() {
      for (const item of items) yield [item.name, item];
    },
  } as unknown as FileSystemDirectoryHandle;
}

it('passes Linux, Windows drive, extended, and UNC document paths unchanged to native authorization', async () => {
  boundary.desktop = true;
  const { parentFolder } = await import('../src/lib/platform');
  for (const documentPath of [
    '/home/user/笔记/文档.md',
    String.raw`C:\Notes\文档.md`,
    String.raw`\\?\C:\Notes\文档.md`,
    String.raw`\\?\UNC\server\share\文档.md`,
  ]) {
    const response = { path: documentPath.slice(0, -5), entries: [] };
    boundary.invoke.mockResolvedValueOnce(response);
    expect(await parentFolder(documentPath)).toBe(response);
    expect(boundary.invoke).toHaveBeenLastCalledWith('parent_folder', { documentPath });
  }
  boundary.invoke.mockRejectedValueOnce(new Error('Not authorized'));
  await expect(parentFolder('/private/secret.md')).rejects.toThrow('Not authorized');
});

it('returns only a known browser parent and preserves its recursive tree', async () => {
  const nested = directory('nested', [file('third.md')]);
  const notes = directory('notes', [file('文档.md'), file('sibling.md'), nested]);
  browser.showDirectoryPicker = vi.fn(async () =>
    directory('workspace', [notes, file('other.md')]),
  );
  const { openFolder, parentFolder, listFolder } = await import('../src/lib/platform');
  await openFolder();
  const parent = await parentFolder('workspace/notes/文档.md');
  expect(parent?.path).toBe('workspace/notes');
  expect(parent?.entries.map((entry) => entry.name)).toEqual(['nested', 'sibling.md', '文档.md']);
  expect(parent?.entries[0].children?.[0].name).toBe('third.md');
  expect(await listFolder(parent!.path)).toEqual(parent!.entries);
  expect(browser.showDirectoryPicker).toHaveBeenCalledOnce();
  expect(boundary.invoke).not.toHaveBeenCalled();
});

it('does not request extra browser access for an isolated file or unknown document', async () => {
  const document = file('文档.md');
  browser.showOpenFilePicker = vi.fn(async () => [document]);
  browser.showDirectoryPicker = vi.fn();
  const { openFiles, parentFolder } = await import('../src/lib/platform');
  const opened = await openFiles();
  expect(await parentFolder(opened[0].path)).toBeNull();
  expect(await parentFolder('private/secret.md')).toBeNull();
  expect(browser.showDirectoryPicker).not.toHaveBeenCalled();
  expect(boundary.invoke).not.toHaveBeenCalled();
});

it('recognizes a selected-file alias after its directory was explicitly granted', async () => {
  const document = file('文档.md');
  browser.showOpenFilePicker = vi.fn(async () => [document]);
  browser.showDirectoryPicker = vi.fn(async () =>
    directory('notes', [document, file('sibling.md')]),
  );
  const { openFiles, openFolder, parentFolder } = await import('../src/lib/platform');
  const opened = await openFiles();
  await openFolder();
  const parent = await parentFolder(opened[0].path);
  expect(parent?.path).toBe('notes');
  expect(parent?.entries).toHaveLength(2);
  expect(browser.showDirectoryPicker).toHaveBeenCalledOnce();
});
