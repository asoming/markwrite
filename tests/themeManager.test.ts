import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeManager, { DocumentThemeStyles } from '../src/components/ThemeManager';
import {
  createImportedTheme,
  loadThemeLibrary,
  saveThemeLibrary,
  themeLibraryKey,
} from '../src/lib/themeImport';
import type { Language } from '../src/lib/types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});
function render(language: Language = 'en') {
  act(() =>
    root.render(
      createElement(
        'div',
        {},
        createElement(ThemeManager, { language }),
        createElement(DocumentThemeStyles),
        createElement('div', { className: 'app-menu', style: { color: 'blue' } }, 'Menu'),
        createElement(
          'div',
          { 'data-custom-document-theme': '' },
          createElement(
            'article',
            { className: 'reader markdown-body' },
            createElement('h1', { id: 'reading-heading' }, 'Document'),
          ),
          createElement(
            'div',
            { className: 'editor-host' },
            createElement(
              'div',
              { className: 'cm-content' },
              createElement('div', { className: 'cm-h1', id: 'live-heading' }, 'Document'),
            ),
          ),
          createElement(
            'div',
            { className: 'editor-host source-mode' },
            createElement(
              'div',
              { className: 'cm-content' },
              createElement('div', { className: 'cm-h1', id: 'source-heading' }, '# Document'),
            ),
          ),
        ),
      ),
    ),
  );
}
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => (item.getAttribute('aria-label') || item.textContent?.trim()) === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const click = async (label: string) => {
  await act(async () => button(label).click());
};
async function chooseFile(name: string, css: string) {
  const file = new File([css], name, { type: 'text/css' });
  Object.defineProperty(file, 'text', { value: async () => css });
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
function nameTheme(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[maxlength="80"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('theme manager', () => {
  it('previews a local CSS file before applying, persists the chosen name, and updates only document styles', async () => {
    render();
    await chooseFile(
      'Typora Custom.css',
      'body {font-family: Georgia} #write h1 {color: rgb(201, 24, 36)}',
    );
    expect(host.querySelector('[data-theme-preview]')).not.toBeNull();
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    expect(loadThemeLibrary().themes).toHaveLength(0);
    nameTheme('My document theme');
    await click('Save and apply theme');
    expect(loadThemeLibrary().themes[0].name).toBe('My document theme');
    expect(loadThemeLibrary().activeId).toBe(loadThemeLibrary().themes[0].id);
    expect(host.querySelector('[data-imported-document-theme]')).not.toBeNull();
    expect(getComputedStyle(host.querySelector('#reading-heading')!).color).toBe(
      'rgb(201, 24, 36)',
    );
    expect(getComputedStyle(host.querySelector('#live-heading')!).color).toBe('rgb(201, 24, 36)');
    expect(getComputedStyle(host.querySelector('#source-heading')!).color).not.toBe(
      'rgb(201, 24, 36)',
    );
    expect(getComputedStyle(host.querySelector('.app-menu')!).color).toBe('rgb(0, 0, 255)');
    await click('Close preview');
    await click('Disable imported theme');
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    expect(loadThemeLibrary().themes).toHaveLength(1);
    await click('Apply theme My document theme');
    expect(host.querySelector('[data-imported-document-theme]')).not.toBeNull();
    await click('Delete theme My document theme');
    expect(loadThemeLibrary().themes).toHaveLength(0);
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
  });

  it('shows compatibility warnings before importing and allows cancellation without changing the active theme', async () => {
    const theme = createImportedTheme('Existing', 'h1 {color: blue}');
    saveThemeLibrary({ version: 1, themes: [theme], activeId: theme.id });
    render();
    await chooseFile(
      'Unsafe.css',
      '@import "https://example.com/theme.css"; body{color: red;background-image:url(relative.png);position:fixed}',
    );
    expect(host.querySelector('.theme-import-notices')?.textContent).toContain(
      'relative paths and network URLs do not load',
    );
    expect(host.querySelector('.theme-import-notices')?.textContent).toContain(
      'Imports, animations',
    );
    expect(loadThemeLibrary().activeId).toBe(theme.id);
    await click('Close preview');
    expect(loadThemeLibrary().themes).toEqual([theme]);
  });

  it('handles malformed files, storage failures and reset recovery in Chinese', async () => {
    render('zh-CN');
    expect(host.textContent).toContain('导入文档主题');
    await chooseFile('broken.css', 'body { color: "broken; }');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('CSS 语法有误');
    await chooseFile('working.css', 'body {color: red}');
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    await click('保存并应用主题');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('主题未保存');
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    storage.mockRestore();
    await click('保存并应用主题');
    await click('清空导入主题');
    await click('取消');
    expect(loadThemeLibrary().themes).toHaveLength(1);
    await click('清空导入主题');
    await click('确认清空');
    expect(loadThemeLibrary().themes).toHaveLength(0);
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已清空导入主题');
  });

  it('recovers a corrupt stored library without touching the document session', async () => {
    localStorage.setItem(themeLibraryKey, '{broken');
    localStorage.setItem('markwrite.session.v1', 'precious document');
    render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Saved themes could not be read',
    );
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    await click('Clear imported themes');
    await click('Confirm clear');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(loadThemeLibrary().themes).toHaveLength(0);
    expect(localStorage.getItem('markwrite.session.v1')).toBe('precious document');
  });

  it('restores persisted theme state and reacts to another window disabling it', async () => {
    const theme = createImportedTheme('Persisted', 'h1 {color: red}');
    saveThemeLibrary({ version: 1, themes: [theme], activeId: theme.id });
    render();
    expect(button('Apply theme Persisted').disabled).toBe(true);
    expect(host.querySelector('[data-imported-document-theme]')).not.toBeNull();
    localStorage.setItem(
      themeLibraryKey,
      JSON.stringify({ version: 1, themes: [theme], activeId: null }),
    );
    await act(async () =>
      window.dispatchEvent(new StorageEvent('storage', { key: themeLibraryKey })),
    );
    expect(host.querySelector('[data-imported-document-theme]')).toBeNull();
    expect(button('Apply theme Persisted').disabled).toBe(false);
  });
});
