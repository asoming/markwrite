import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document, Mode, Settings } from '../src/lib/types';
import { setLanguage } from '../src/lib/i18n';

const boundary = vi.hoisted(() => ({ openFiles: vi.fn() }));
vi.mock('../src/lib/platform', async (original) => ({
  ...(await original<typeof import('../src/lib/platform')>()),
  desktop: false,
  openFiles: boundary.openFiles,
}));
// This suite verifies App state transitions, not the editor's rendering machinery.
// The real menu, preferences, import dialog, converter, and recovery storage are used.
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
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLanguage('zh-CN');
  localStorage.clear();
  boundary.openFiles.mockReset();
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
  const result = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
    (item) => (item.getAttribute('aria-label') || item.textContent?.trim()) === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}
function click(element: HTMLElement) {
  act(() => element.click());
}
function keyboard(key: string) {
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
}
function change(label: string, value: string) {
  const input = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function currentMode() {
  return host.querySelector('[data-testid="document-buffer"]')?.getAttribute('data-mode');
}
function snapshot(): { docs: Document[]; active: string; settings: Settings } {
  act(() => window.dispatchEvent(new Event('beforeunload')));
  return JSON.parse(localStorage.getItem('markwrite.session.v1')!);
}
async function openFile(path: string, content: string) {
  boundary.openFiles.mockResolvedValueOnce([
    { path, content, version: 'v1', bom: false, crlf: false },
  ]);
  await act(async () => keyboard('o'));
  expect(boundary.openFiles).toHaveBeenCalled();
}

describe('application preferences and document import', () => {
  it('starts in reading mode, opens files for reading, and creates new documents ready to edit', async () => {
    expect(currentMode()).toBe('read');
    expect(host.querySelector('[data-testid="reading-buffer"]')).not.toBeNull();
    keyboard('n');
    expect(currentMode()).toBe('live');
    await openFile('/notes/文件.md', '# 文件\n\n保存与编辑');
    expect(currentMode()).toBe('read');
    expect(host.querySelector('[data-testid="reading-buffer"]')?.textContent).toBe(
      '# 文件\n\n保存与编辑',
    );
    const state = snapshot();
    expect(state.docs.find((document) => document.id === state.active)).toMatchObject({
      path: '/notes/文件.md',
      saved: '# 文件\n\n保存与编辑',
      status: 'clean',
    });
  });

  it('applies the changed opening preference to later opens without changing the current document', async () => {
    keyboard(',');
    click(button('编辑器', '[role="tab"]'));
    change('默认打开模式', 'source');
    expect(currentMode()).toBe('read');
    click(button('关闭设置'));
    await openFile('/notes/source.md', '# 原文\n\n**不改写正文**');
    expect(currentMode()).toBe('source');
    expect(host.querySelector('[data-testid="document-buffer"]')?.textContent).toBe(
      '# 原文\n\n**不改写正文**',
    );
    keyboard('n');
    expect(currentMode()).toBe('live');
    await openFile('/notes/source.md', '# 原文\n\n**不改写正文**');
    expect(currentMode()).toBe('source');
    expect(snapshot().settings.defaultMode).toBe('source');
  });

  it('switches the application to English and confirms an imported document as an unsaved draft', async () => {
    const before = snapshot();
    keyboard(',');
    change('界面语言', 'en');
    expect(host.querySelector('.editing-menu-group>button')?.textContent).toBe('File');
    expect(snapshot().docs).toEqual(before.docs);
    click(button('Close preferences'));
    click(button('File', '.editing-menu-group>button'));
    const importAction = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
      (item) => item.textContent?.includes('Import files'),
    )!;
    click(importAction);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Import documents',
    );

    const bytes = new TextEncoder().encode('文件\n保存与编辑');
    const file = new File([bytes], '笔记.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
    const fileInput = host.querySelector<HTMLInputElement>('.import-panel input[type="file"]')!;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    expect(host.querySelector('.import-preview pre')?.textContent).toBe('文件\n保存与编辑');
    expect(snapshot().docs).toEqual(before.docs);
    click(button('Import as Markdown (1)'));
    expect(host.querySelector('.import-panel')).toBeNull();
    const state = snapshot();
    expect(state.settings.language).toBe('en');
    expect(state.docs).toHaveLength(before.docs.length + 1);
    expect(state.docs.find((document) => document.id === state.active)).toMatchObject({
      name: '笔记.md',
      content: '文件\n保存与编辑',
      saved: '',
      status: 'dirty',
    });
    expect(state.docs.find((document) => document.id === state.active)?.path).toBeUndefined();
    expect(currentMode()).toBe('read');
    expect(host.querySelector('[data-testid="reading-buffer"]')?.textContent).toBe(
      '文件\n保存与编辑',
    );
  });
});
