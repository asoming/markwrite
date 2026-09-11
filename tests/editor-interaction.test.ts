import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import Editor, { releaseEditor } from '../src/editor/Editor';
import { configureInlineSyntax } from '../src/lib/markdown';
import { starterExtension } from '../src/lib/extensions';
import { setLanguage } from '../src/lib/i18n';
import { undo } from '@codemirror/commands';
import { getSearchQuery, openSearchPanel, SearchQuery, setSearchQuery } from '@codemirror/search';

let host: HTMLDivElement;
let root: Root;
let view: EditorView | null = null;
let id = '';
beforeEach(() => {
  setLanguage('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  id = crypto.randomUUID();
});
afterEach(() => {
  act(() => root.unmount());
  releaseEditor(id);
  host.remove();
  setLanguage('zh-CN');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(content: string, onLink = vi.fn(), onEditTable = vi.fn()) {
  act(() =>
    root.render(
      createElement(Editor, {
        id,
        content,
        mode: 'live',
        onChange: vi.fn(),
        onReady: (editor) => {
          view = editor;
        },
        onSelection: vi.fn(),
        onImage: vi.fn(),
        onComposition: vi.fn(),
        onLink,
        onEditTable,
      }),
    ),
  );
}
it('routes rendered table links through the app and never navigates the WebView', () => {
  const onLink = vi.fn();
  const source = '正文\n\n| 文档 |\n| --- |\n| [相对链接](./说明.md) |';
  mount(source, onLink);
  const anchor = host.querySelector<HTMLAnchorElement>('.live-block a')!;
  expect(anchor).not.toBeNull();
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => anchor.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(decodeURIComponent(onLink.mock.calls[0][0])).toBe('./说明.md');
  expect(view!.state.doc.toString()).toBe(source);
});
it('opens a rendered table grid without forcing source editing', () => {
  const onTable = vi.fn();
  const source = '正文\n\n| 标题 |\n| --- |\n| 内容 |';
  mount(source, vi.fn(), onTable);
  const button = host.querySelector<HTMLButtonElement>('.live-block-tools button')!;
  act(() => button.click());
  expect(onTable).toHaveBeenCalledWith({ from: 4, to: source.length });
  expect(view!.state.selection.main.from).toBe(0);
});
it('loads network images only after an explicit click and survives malformed URLs', () => {
  mount('正文\n\n![截图](https://example.com/a.png)\n\n![错误](http://)');
  const images = host.querySelectorAll<HTMLImageElement>('.live-block img');
  expect(images.length).toBe(2);
  expect(images[0].getAttribute('src')).toBeNull();
  expect(images[1].getAttribute('src')).toBeNull();
  expect(images[1].title).toContain('地址无效');
  const button = host.querySelector<HTMLButtonElement>('.remote-image-load')!;
  expect(button.textContent).toContain('example.com');
  act(() => button.click());
  expect(images[0].src).toBe('https://example.com/a.png');
  expect(images[0].referrerPolicy).toBe('no-referrer');
});
it('renders inactive inline math but leaves literal dollar syntax in code unchanged', () => {
  mount('正文\n\n公式 $x^2$，代码 `$literal$`。');
  expect(host.querySelectorAll('.cm-inline-math').length).toBe(1);
  expect(host.querySelector('.cm-inline-math')?.getAttribute('aria-label')).toBe('公式 x^2');
});
it('reconfigures declarative inline syntax without replacing document text or undo state', () => {
  configureInlineSyntax([]);
  const source = '正文\n\n==高亮内容 **保持字面文本**==';
  mount(source);
  expect(host.querySelector('.cm-custom-syntax')).toBeNull();
  act(() => {
    configureInlineSyntax([starterExtension]);
  });
  expect(host.querySelector('.cm-custom-syntax')?.textContent).toBe('高亮内容 **保持字面文本**');
  expect(view!.state.doc.toString()).toBe(source);
  act(() => {
    configureInlineSyntax([]);
  });
  expect(host.querySelector('.cm-custom-syntax')).toBeNull();
  expect(view!.state.doc.toString()).toBe(source);
});
it('switches editor interface language while retaining source, selection, and undo history', () => {
  const source = '文件\n\n| 标题 |\n| --- |\n| 保存 |';
  mount(source);
  act(() => view!.dispatch({ changes: { from: 0, insert: '编辑' }, selection: { anchor: 1 } }));
  const editor = view!;
  expect(host.querySelector('.live-block-tools button')?.textContent).toContain('编辑表格');
  act(() => setLanguage('en'));
  expect(view).toBe(editor);
  expect(editor.contentDOM.getAttribute('aria-label')).toBe('Markdown editor');
  expect(host.querySelector('.live-block-tools button')?.textContent).toBe('Edit table');
  expect(editor.state.doc.toString()).toBe('编辑' + source);
  expect(editor.state.selection.main.anchor).toBe(1);
  act(() => {
    undo(editor);
  });
  expect(editor.state.doc.toString()).toBe(source);
  act(() => setLanguage('zh-CN'));
  expect(editor.contentDOM.getAttribute('aria-label')).toBe('Markdown 编辑器');
  expect(editor.state.doc.toString()).toBe(source);
});
it('refreshes an open search panel without losing its query or replacement options', () => {
  mount('文件\n\n保存');
  act(() => {
    view!.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: '文件', replace: '保存', caseSensitive: true }),
      ),
    });
    openSearchPanel(view!);
  });
  expect(host.querySelector('input[name="search"]')?.getAttribute('placeholder')).toBe('查找');
  act(() => setLanguage('en'));
  expect(host.querySelector('input[name="search"]')?.getAttribute('placeholder')).toBe('Find');
  expect(getSearchQuery(view!.state)).toMatchObject({
    search: '文件',
    replace: '保存',
    caseSensitive: true,
  });
  expect(view!.state.doc.toString()).toBe('文件\n\n保存');
  act(() => setLanguage('zh-CN'));
  expect(host.querySelector('input[name="search"]')?.getAttribute('placeholder')).toBe('查找');
});
