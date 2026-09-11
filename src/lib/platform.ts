import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DiskFile, FileEntry, SearchHit } from './types';
import { normalizeContent, serializeContent } from './markdown';
export const desktop = isTauri();
// Browser handles are intentionally session-scoped. Restored buffers remain drafts until reopened.
const handles = new Map<string, FileSystemFileHandle>();
const folders = new Map<string, FileSystemDirectoryHandle>();
type PickerWindow = Window & {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle>;
};
const pickers = window as PickerWindow;
async function digest(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
async function registerHandle(handle: FileSystemFileHandle) {
  for (const [path, existing] of handles) if (await handle.isSameEntry(existing)) return path;
  const path = `file:${crypto.randomUUID()}/${handle.name}`;
  handles.set(path, handle);
  return path;
}
async function fromHandle(path: string, handle: FileSystemFileHandle): Promise<DiskFile> {
  const f = await handle.getFile();
  const buffer = await f.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return {
    path,
    content: normalizeContent(raw),
    version: await digest(buffer),
    bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
    crlf: raw.includes('\r\n'),
  };
}
export async function openFiles(): Promise<DiskFile[]> {
  if (desktop) return invoke('choose_files');
  if (pickers.showOpenFilePicker) {
    const selected = await pickers.showOpenFilePicker({
      multiple: true,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
    });
    return Promise.all(
      selected.map(async (h) => {
        const path = await registerHandle(h);
        return fromHandle(path, h);
      }),
    );
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown';
    input.multiple = true;
    input.oncancel = () => resolve([]);
    input.onchange = async () =>
      resolve(
        await Promise.all(
          [...(input.files || [])].map(async (f) => {
            const raw = await f.text();
            return {
              path: '',
              content: normalizeContent(raw),
              version: '',
              bom: false,
              crlf: raw.includes('\r\n'),
              name: f.name,
            };
          }),
        ),
      );
    input.click();
  });
}
export async function readFile(path: string): Promise<DiskFile> {
  if (desktop) return invoke('read_document', { path });
  const h = handles.get(path);
  if (!h) throw new Error('请重新打开这个文件，恢复与原文件的连接。当前草稿已保留。');
  return fromHandle(path, h);
}
export async function writeFile(file: DiskFile): Promise<DiskFile> {
  if (desktop) return invoke('save_document', { file });
  const handle = handles.get(file.path);
  if (!handle) throw new Error('请使用“另存为”选择保存位置。');
  const disk = await fromHandle(file.path, handle);
  if (disk.version !== file.version) throw new Error('CONFLICT:文件已被外部修改');
  const writable = await handle.createWritable();
  try {
    await writable.write(serializeContent(file.content, file.bom, file.crlf));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return fromHandle(file.path, handle);
}
export async function saveAs(content: string, name: string): Promise<DiskFile | null> {
  if (desktop) return invoke('save_as', { content, name });
  if (!pickers.showSaveFilePicker) {
    download(content, name, 'text/markdown');
    return null;
  }
  const handle = await pickers.showSaveFilePicker({
    suggestedName: name.endsWith('.md') ? name : `${name}.md`,
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
  });
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
  const path = await registerHandle(handle);
  return fromHandle(path, handle);
}
async function scan(
  handle: FileSystemDirectoryHandle,
  prefix: string,
  depth = 0,
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  if (depth > 12) return entries;
  for await (const [name, item] of (
    handle as unknown as { entries: () => AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    if (name.startsWith('.') || ['node_modules', 'target'].includes(name)) continue;
    const path = `${prefix}/${name}`;
    if (item.kind === 'directory') {
      folders.set(path, item as FileSystemDirectoryHandle);
      entries.push({
        name,
        path,
        directory: true,
        children: await scan(item as FileSystemDirectoryHandle, path, depth + 1),
      });
    } else {
      handles.set(path, item as FileSystemFileHandle);
      if (/\.(md|markdown)$/i.test(name)) entries.push({ name, path, directory: false });
    }
  }
  return entries.sort(
    (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}
export async function openFolder(): Promise<{ path: string; entries: FileEntry[] } | null> {
  if (desktop) return invoke('choose_folder');
  if (!pickers.showDirectoryPicker)
    throw new Error('当前浏览器不支持打开文件夹，请使用桌面版或 Chrome。');
  const h = await pickers.showDirectoryPicker({ mode: 'readwrite' });
  folders.set(h.name, h);
  return { path: h.name, entries: await scan(h, h.name) };
}
export async function listFolder(path: string): Promise<FileEntry[]> {
  if (desktop) return invoke('list_folder', { path });
  const h = folders.get(path);
  if (!h) throw new Error('请重新打开文件夹。');
  return scan(h, path);
}
export async function createEntry(
  parent: string,
  name: string,
  directory: boolean,
): Promise<string> {
  if (!name.trim() || /[/\\\0]/.test(name) || name === '.' || name === '..')
    throw new Error('名称不能包含路径分隔符。');
  if (desktop) return invoke('create_entry', { parent, name, directory });
  const h = folders.get(parent);
  if (!h) throw new Error('请先打开文件夹。');
  try {
    await h.getFileHandle(name);
    throw new Error('同名文件已存在。');
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
  }
  if (directory) await h.getDirectoryHandle(name, { create: true });
  else {
    const file = await h.getFileHandle(name, { create: true });
    handles.set(`${parent}/${name}`, file);
  }
  return `${parent}/${name}`;
}
export async function renameFile(path: string, name: string): Promise<string> {
  if (desktop) return invoke('rename_document', { path, name });
  throw new Error('浏览器预览暂不支持重命名，请使用“另存为”。');
}
export async function searchFolder(
  path: string,
  query: string,
  requestId?: string,
): Promise<SearchHit[]> {
  if (desktop) return invoke('search_folder', { path, query, requestId });
  const hits: SearchHit[] = [];
  for (const [p, h] of handles) {
    if (!p.startsWith(`${path}/`) || !/\.(md|markdown)$/i.test(p)) continue;
    const f = await h.getFile();
    if (f.size > 10 * 1024 * 1024) continue;
    (await f.text()).split('\n').forEach((text, i) => {
      if (text.toLowerCase().includes(query.toLowerCase()) && hits.length < 500)
        hits.push({ path: p, line: i + 1, text });
    });
  }
  return hits;
}
export async function migrateEmbeddedImages(path: string, content: string) {
  const images = [
    ...new Set(
      content.match(/data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]+/gi) || [],
    ),
  ];
  let result = content;
  for (const data of images) {
    const [header, base64] = data.split(',');
    const mime = header.slice(5).split(';')[0];
    const extension = mime.split('/')[1].replace('jpeg', 'jpg');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const asset = await attachImage(path, new File([bytes], `image.${extension}`, { type: mime }));
    result = result.split(data).join(asset);
  }
  return result;
}
export async function assetData(documentPath: string, asset: string): Promise<string> {
  if (/^data:image\//.test(asset)) return asset;
  if (/^[a-z]+:/i.test(asset)) throw new Error('外部图片未自动加载');
  if (desktop) return invoke('read_asset', { documentPath, asset });
  const parts =
    `${documentPath.slice(0, documentPath.lastIndexOf('/'))}/${decodeURIComponent(asset)}`.split(
      '/',
    );
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '..') normalized.pop();
    else if (part !== '.') normalized.push(part);
  }
  const h = handles.get(normalized.join('/'));
  if (!h) throw new Error('请打开图片所在的文件夹。');
  const f = await h.getFile();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(f);
  });
}
export async function attachImage(path: string | undefined, file: File): Promise<string> {
  if (desktop && path)
    return invoke('attach_image', {
      path,
      name: file.name,
      bytes: [...new Uint8Array(await file.arrayBuffer())],
    });
  // Data URI keeps unsaved drafts self-contained; an explicit limitation documented in README.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
export function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportHtml(html: string, name: string): Promise<boolean> {
  if (desktop) return invoke('export_html', { html, name });
  download(html, name, 'text/html');
  return true;
}
export async function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持打开 HTTP 或 HTTPS 外部链接。');
  if (desktop) await invoke('open_external', { url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}
