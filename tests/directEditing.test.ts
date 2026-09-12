import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Editor, { releaseEditor } from '../src/editor/Editor';
import Reader from '../src/Reader';
import { setLanguage } from '../src/lib/i18n';
import { imageDimension, parseImageMarkup, serializeImageMarkup } from '../src/lib/imageMarkup';
import { renderMarkdown } from '../src/lib/markdown';

let host: HTMLDivElement;
let root: Root;
let view: EditorView;
let id = '';
const pixel = 'data:image/png;base64,iVBORw0KGgo=';
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLanguage('zh-CN');
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(content: string, composition = vi.fn()) {
  act(() =>
    root.render(
      createElement(Editor, {
        id,
        content,
        mode: 'live',
        onChange: vi.fn(),
        onReady: (editor) => {
          if (editor) view = editor;
        },
        onSelection: vi.fn(),
        onImage: vi.fn(),
        onComposition: composition,
      }),
    ),
  );
}
function beginCell(row = 1, column = 0) {
  const cell = host.querySelector('table')!.rows[row].cells[column];
  act(() => cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  const input = cell.querySelector('textarea')!;
  expect(input).not.toBeNull();
  return input;
}
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function press(element: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  act(() =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
    ),
  );
}
function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(button).not.toBeNull();
  act(() => button.click());
}
function selectImage() {
  const image = host.querySelector<HTMLImageElement>('.live-block img')!;
  expect(image).not.toBeNull();
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 800 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 400 });
  act(() => image.click());
  return image;
}

describe('table cells in the document', () => {
  it('allows native drag initiation and moves one table row with one undo', () => {
    const source = '正文\n\n| A | B |\n| --- | --- |\n| first | 1 |\n| second | 2 |\n\n末尾';
    mount(source);
    beginCell(1, 0);
    const handle = host.querySelector<HTMLButtonElement>(
      'button[aria-label="拖动当前行到目标单元格"]',
    )!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => handle.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(false);
    act(() => handle.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true })));
    act(() =>
      host
        .querySelector('table')!
        .rows[2].cells[0].dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })),
    );
    expect(view.state.doc.toString()).toContain('| second | 2 |\n| first | 1 |');
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
  });

  it('pastes a rectangular range, expands columns and undoes the entire operation', () => {
    const source = '正文\n\n| A | B |\n| :--- | ---: |\n| keep | old |\n\n末尾';
    mount(source);
    const edit = beginCell(1, 1);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'x\ty|z\n2\t3\n' } });
    act(() => edit.dispatchEvent(event));
    expect(view.state.doc.toString()).toBe(
      '正文\n\n| A | B |  |\n| :--- | ---: | --- |\n| keep | x | y\\|z |\n|  | 2 | 3 |\n\n末尾',
    );
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
  });
  it('sorts body rows numerically and moves columns with their alignment', () => {
    const source = '正文\n\n| Name | Count |\n| :--- | ---: |\n| ten | 10 |\n| two | 2 |';
    mount(source);
    beginCell(1, 1);
    click('按当前列升序');
    expect(view.state.doc.toString()).toContain('| two | 2 |\n| ten | 10 |');
    beginCell(1, 1);
    click('左移当前列');
    expect(view.state.doc.toString()).toContain('| Count | Name |\n| ---: | :--- |\n| 2 | two |');
    act(() => undo(view));
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
  });
  it('keeps the table structure when text contains even backslashes before a pipe', () => {
    mount('正文\n\n| A | B |\n| --- | --- |\n| a | untouched |');
    const edit = beginCell();
    input(edit, String.raw`path\\|value`);
    press(edit, 'Enter');
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(view.state.doc.toString());
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
    expect(container.querySelector('tbody td:last-child')?.textContent).toBe('untouched');
  });
  it('edits cells in place, escapes pipes/newlines, preserves other source and groups undo', () => {
    const source = '正文\n\n| Name  | Value |\n| :--- | ---: |\n| a\\|b | **保留** |\n\n末尾';
    mount(source);
    const edit = beginCell();
    expect(edit.value).toBe('a|b');
    input(edit, '新');
    expect(host.querySelector('textarea.direct-table-input')).toBe(edit);
    expect(document.activeElement).toBe(edit);
    input(edit, '新的|内容\n第二行');
    expect(view.state.doc.toString()).toBe(source.replace('a\\|b', '新的\\|内容<br>第二行'));
    press(edit, 'Enter');
    expect(host.querySelector('.direct-table-input')).toBeNull();
    expect(host.querySelector('td')?.textContent).toContain('新的|内容');
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
    act(() => redo(view));
    expect(view.state.doc.toString()).toContain('新的\\|内容<br>第二行');
  });

  it('keeps Chinese composition in the same input and commits after composition ends', () => {
    const composition = vi.fn();
    mount('正文\n\n| 标题 |\n| --- |\n| 内容 |', composition);
    const edit = beginCell();
    act(() => edit.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    input(edit, 'zhong');
    expect(view.state.doc.toString()).toContain('| 内容 |');
    expect(host.querySelector('.direct-table-input')).toBe(edit);
    input(edit, '中文输入');
    act(() =>
      edit.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }),
      ),
    );
    expect(view.state.doc.toString()).toContain('| 中文输入 |');
    expect(document.activeElement).toBe(edit);
    expect(composition.mock.calls.map(([value]) => value)).toEqual([true, false]);
  });

  it('uses Tab to move to the next cell without replacing or dropping entered content', () => {
    mount('正文\n\n| A | B |\n| --- | --- |\n| a | b |');
    const edit = beginCell();
    input(edit, '第一个');
    press(edit, 'Tab');
    const next = host.querySelector<HTMLTextAreaElement>('.direct-table-input')!;
    expect(next).not.toBe(edit);
    expect(next.value).toBe('b');
    input(next, '第二个');
    press(next, 'Escape');
    expect(view.state.doc.toString()).toContain('| 第一个 | 第二个 |');
    act(() => undo(view));
    expect(view.state.doc.toString()).toContain('| 第一个 | b |');
  });

  it('does not overwrite external changes with a stale cell input', () => {
    mount('正文\n\n| 标题 |\n| --- |\n| 原来 |');
    const edit = beginCell();
    act(() =>
      view.dispatch({
        changes: { from: view.state.doc.length - 4, to: view.state.doc.length - 2, insert: '外部' },
      }),
    );
    expect(edit.isConnected).toBe(false);
    input(edit, '失效输入');
    expect(view.state.doc.toString()).not.toContain('失效输入');
  });
  it('lets document save shortcuts reach the application while a cell has focus', () => {
    mount('正文\n\n| 标题 |\n| --- |\n| 内容 |');
    const edit = beginCell();
    const handler = vi.fn();
    window.addEventListener('keydown', handler);
    press(edit, 's', { ctrlKey: true });
    window.removeEventListener('keydown', handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toContain('| 内容 |');
  });
});

describe('image size and preview', () => {
  it('applies a caption, alignment and replacement path as one undoable edit', () => {
    const source = `正文\n\n![截图](${pixel})\n\n末尾`;
    mount(source);
    selectImage();
    input(
      document.querySelector<HTMLInputElement>('[aria-label="图片路径或网址"]')!,
      '子目录/新 图.png',
    );
    input(document.querySelector<HTMLInputElement>('[aria-label="图注"]')!, '图一 <示例>');
    const alignment = document.querySelector<HTMLSelectElement>('[aria-label="图片对齐"]')!;
    alignment.value = 'center';
    click('应用图片尺寸');
    const content = view.state.doc.toString();
    expect(content).toContain('<figure style="text-align: center">');
    expect(content).toContain('src="子目录/新 图.png"');
    expect(content).toContain('<figcaption>图一 &lt;示例&gt;</figcaption>');
    expect(renderMarkdown(content)).toContain('text-align: center');
    expect(content.endsWith('\n\n末尾')).toBe(true);
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
  });
  it('rejects a dangerous replacement path without changing the original document', () => {
    const source = `正文\n\n![截图](${pixel})`;
    mount(source);
    selectImage();
    input(
      document.querySelector<HTMLInputElement>('[aria-label="图片路径或网址"]')!,
      'javascript:alert(1)',
    );
    click('应用图片尺寸');
    expect(view.state.doc.toString()).toBe(source);
    expect(document.querySelector('.direct-image-error')?.textContent).toContain('路径无效');
  });
  it('commits drag resizing once and cancels an interrupted drag without changing Markdown', () => {
    const source = `正文\n\n![截图](${pixel})`;
    mount(source);
    const image = selectImage();
    image.getBoundingClientRect = () => new DOMRect(100, 100, 400, 200);
    const handle = host.querySelector<HTMLButtonElement>('.direct-image-resize')!;
    function pointer(type: string, x: number) {
      act(() =>
        handle.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, cancelable: true })),
      );
    }
    pointer('pointerdown', 500);
    pointer('pointermove', 600);
    expect(view.state.doc.toString()).toBe(source);
    expect(image.style.width).toBe('500px');
    pointer('pointercancel', 600);
    expect(view.state.doc.toString()).toBe(source);
    pointer('pointerdown', 500);
    pointer('pointermove', 700);
    pointer('pointerup', 700);
    expect(view.state.doc.toString()).toContain('width="600" height="300"');
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
  });
  it('keeps untouched Markdown and saves proportional dimensions as safe HTML with undo', () => {
    const source = `正文\n\n![截图](${pixel})\n\n末尾`;
    mount(source);
    const image = selectImage();
    expect(view.state.doc.toString()).toBe(source);
    input(document.querySelector<HTMLInputElement>('[aria-label="图片宽度"]')!, '400');
    expect(document.querySelector<HTMLInputElement>('[aria-label="图片高度"]')!.value).toBe('200');
    click('应用图片尺寸');
    expect(view.state.doc.toString()).toContain('width="400" height="200"');
    expect(host.querySelector('.live-block img')).toBe(image);
    expect(image.getAttribute('width')).toBe('400');
    act(() => undo(view));
    expect(view.state.doc.toString()).toBe(source);
    expect(image.getAttribute('width')).toBeNull();
  });

  it('restores saved sizes and rejects invalid input without changing the document', () => {
    const source = `正文\n\n<img src="${pixel}" alt="样图" width="320" height="160">`;
    mount(source);
    const image = selectImage();
    expect(document.querySelector<HTMLInputElement>('[aria-label="图片宽度"]')!.value).toBe('320');
    expect(image.style.aspectRatio).toBe('320 / 160');
    input(document.querySelector<HTMLInputElement>('[aria-label="图片宽度"]')!, '10001');
    const form = document.querySelector('form.direct-image-tools')!;
    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(view.state.doc.toString()).toBe(source);
    expect(form.querySelector('[role="status"]')?.textContent).toContain('10000');
  });

  it('previews only loaded images, closes with Escape and exposes no editing controls in reading mode', () => {
    const content = `![本地图](${pixel})\n\n![远端](https://example.com/a.png)`;
    act(() => root.render(createElement(Reader, { content, onLink: vi.fn() })));
    const images = host.querySelectorAll('img');
    act(() => images[1].click());
    expect(document.querySelector('.image-preview-backdrop')).toBeNull();
    expect(images[1].getAttribute('src')).toBeNull();
    act(() => images[0].click());
    expect(document.querySelector('.image-preview-backdrop img')?.getAttribute('src')).toBe(pixel);
    expect(document.querySelector('.direct-image-tools')).toBeNull();
    press(document.querySelector('.image-preview-close')!, 'Escape');
    expect(document.querySelector('.image-preview-backdrop')).toBeNull();
  });

  it('serializes only numeric dimensions and escaped attributes while retaining remote-load consent', () => {
    expect(parseImageMarkup('![a\\] &amp; **bold**](<assets/a.png> "a &amp; b")')).toMatchObject({
      source: 'assets/a.png',
      alt: 'a] & bold',
      title: 'a & b',
    });
    expect(imageDimension('50%')).toBeUndefined();
    expect(imageDimension('NaN')).toBeUndefined();
    expect(imageDimension(0)).toBeUndefined();
    expect(imageDimension(10001)).toBeUndefined();
    expect(parseImageMarkup('<img src="javascript:alert(1)">')).toBeNull();
    expect(parseImageMarkup('<img src="x"><script>alert(1)</script>')).toBeNull();
    const markup = serializeImageMarkup(
      { source: 'https://example.com/a?x=1&y=2', alt: '\" onerror=\"oops', title: 'a < b' },
      { width: 640 },
    );
    const container = document.createElement('div');
    container.innerHTML = renderMarkdown(markup);
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBeNull();
    expect(image.getAttribute('onerror')).toBeNull();
    expect(image.dataset.asset).toBe('https://example.com/a?x=1&y=2');
    expect(image.getAttribute('width')).toBe('640');
    expect(image.alt).toBe('\" onerror=\"oops');
  });
});
