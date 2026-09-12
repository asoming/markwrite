import { createElement, act, StrictMode, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import Editor, { releaseEditor } from '../src/editor/Editor';
import { configureInlineSyntax } from '../src/lib/markdown';
import { starterExtension } from '../src/lib/extensions';
import { setLanguage } from '../src/lib/i18n';
import { undo } from '@codemirror/commands';
import { applyFormatting } from '../src/editor/formatting';
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

function mountReadingDocument(strict: boolean) {
  let command!: (run: (editor: EditorView) => void) => void;
  let read!: () => void;
  let replace!: (content: string) => void;
  let content = '';
  function Document() {
    const [source, setSource] = useState('正文');
    const [editing, setEditing] = useState(false);
    const pending = useRef<((editor: EditorView) => void) | undefined>(undefined);
    content = source;
    replace = setSource;
    read = () => setEditing(false);
    command = (run) => {
      pending.current = run;
      setEditing(true);
    };
    return editing
      ? createElement(Editor, {
          id,
          content: source,
          mode: 'live',
          onChange: setSource,
          onReady: (editor) => {
            view = editor;
            if (editor && pending.current) {
              const run = pending.current;
              pending.current = undefined;
              run(editor);
            }
          },
          onSelection: () => {},
          onImage: () => {},
          onComposition: () => {},
        })
      : createElement('article', null, source);
  }
  act(() =>
    root.render(
      strict ? createElement(StrictMode, null, createElement(Document)) : createElement(Document),
    ),
  );
  return {
    command: (run: (editor: EditorView) => void) => act(() => command(run)),
    read: () => act(() => read()),
    replace: (text: string) => act(() => replace(text)),
    content: () => content,
  };
}

it.each([false, true])(
  'keeps the first reading-mode heading command (StrictMode: %s)',
  (strict) => {
    const document = mountReadingDocument(strict);
    document.command((editor) => applyFormatting(editor, 'heading1'));
    expect(document.content()).toBe('# 正文');
    expect(view!.state.doc.toString()).toBe('# 正文');
  },
);

it.each([false, true])('keeps the first reading-mode bold command (StrictMode: %s)', (strict) => {
  const document = mountReadingDocument(strict);
  document.command((editor) => applyFormatting(editor, 'bold'));
  expect(document.content()).toBe('**文字**正文');
  expect(view!.state.doc.toString()).toBe('**文字**正文');
});

it.each([false, true])(
  'undoes immediately after returning from reading (StrictMode: %s)',
  (strict) => {
    const document = mountReadingDocument(strict);
    document.command(() => {});
    act(() => view!.dispatch({ changes: { from: 0, insert: '编辑' }, userEvent: 'input' }));
    expect(document.content()).toBe('编辑正文');
    document.read();
    expect(view).toBeNull();
    document.command((editor) => undo(editor));
    expect(document.content()).toBe('正文');
    expect(view!.state.doc.toString()).toBe('正文');
  },
);

it('synchronizes a changed reading buffer before announcing the restored editor', () => {
  const document = mountReadingDocument(true);
  document.command(() => {});
  document.read();
  document.replace('磁盘更新');
  document.command((editor) => applyFormatting(editor, 'heading1'));
  expect(document.content()).toBe('# 磁盘更新');
  expect(view!.state.doc.toString()).toBe('# 磁盘更新');
});

it('keeps rendered blocks mounted while an IME candidate is composing', async () => {
  const { compositionState } = await import('../src/editor/livePreview');
  mount('| 标题 |\n| --- |\n| 内容 |\n\n输入位置');
  act(() => view!.dispatch({ selection: { anchor: view!.state.doc.length } }));
  const table = host.querySelector('.live-block table');
  expect(table).not.toBeNull();
  act(() => view!.dispatch({ effects: compositionState.of(true) }));
  expect(host.querySelector('.live-block table')).toBe(table);
  act(() => view!.dispatch({ changes: { from: view!.state.doc.length, insert: '你好' } }));
  expect(host.querySelector('.live-block table')).toBe(table);
  act(() => view!.dispatch({ effects: compositionState.of(false) }));
  expect(view!.state.doc.toString()).toContain('输入位置你好');
  expect(host.querySelector('.live-block table')!.textContent).toContain('内容');
});

it('does not replace newer typing with a delayed acknowledgement from React', () => {
  mount('base');
  act(() => view!.dispatch({ changes: { from: 4, insert: 'a' }, userEvent: 'input.type' }));
  act(() => view!.dispatch({ changes: { from: 5, insert: 'b' }, userEvent: 'input.type' }));
  mount('basea');
  expect(view!.state.doc.toString()).toBe('baseab');
  mount('baseab');
  expect(view!.state.doc.toString()).toBe('baseab');
  mount('external replacement');
  expect(view!.state.doc.toString()).toBe('external replacement');
});
