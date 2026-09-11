import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EditingMenu from '../src/components/EditingMenu';
import InsertDialog from '../src/components/InsertDialog';
import { setLanguage, t } from '../src/lib/i18n';
import Reader from '../src/Reader';
import DiffView from '../src/components/DiffView';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguage('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguage('zh-CN');
  vi.unstubAllGlobals();
});
const click = (element: Element | null) => {
  expect(element).not.toBeNull();
  act(() => {
    (element as HTMLButtonElement).click();
  });
};
const change = (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) => {
  act(() => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
};

describe('editing menus and insertion dialogs', () => {
  it('switches menus instantly while preserving their actions and theme selection', () => {
    const action = vi.fn();
    act(() =>
      root.render(
        createElement(EditingMenu, {
          onAction: action,
          mode: 'read',
          theme: 'night',
          focus: false,
        }),
      ),
    );
    click(host.querySelector('.editing-menu-group>button'));
    expect(host.querySelector('[role="menu"]')?.textContent).toContain('导入文件');
    act(() => setLanguage('en'));
    expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('File');
    click(
      [...host.querySelectorAll('[role="menu"] button')].find((button) =>
        button.textContent?.includes('Import files'),
      )!,
    );
    expect(action).toHaveBeenLastCalledWith('app:import');
    click(
      [...host.querySelectorAll('.editing-menu-group>button')].find(
        (button) => button.textContent === 'Theme',
      )!,
    );
    expect(
      [...host.querySelectorAll('[role="menuitemradio"]')]
        .find((button) => button.textContent?.includes('Night'))
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    click(
      [...host.querySelectorAll('[role="menuitemradio"]')].find((button) =>
        button.textContent?.includes('Github'),
      )!,
    );
    expect(action).toHaveBeenLastCalledWith('theme:github');
    act(() => setLanguage('zh-CN'));
    expect(host.querySelector('.editing-menu-group>button')?.textContent).toBe('文件');
  });
  it('translates interface templates without translating interpolated user content', () => {
    setLanguage('en');
    expect(t('关闭 {0}', undefined, ['文件'])).toBe('Close 文件');
    expect(t('未收录的界面词', 'Fallback label')).toBe('Fallback label');
    expect(document.documentElement.lang).toBe('en');
  });
  it('keeps typed insertion values and document paths unchanged across language switches', () => {
    const insert = vi.fn();
    act(() =>
      root.render(
        createElement(InsertDialog, { kind: 'link', onClose: vi.fn(), onInsert: insert }),
      ),
    );
    change(host.querySelectorAll<HTMLInputElement>('input')[0], '文件');
    change(host.querySelectorAll<HTMLInputElement>('input')[1], './文件/保存.md');
    act(() => setLanguage('en'));
    expect(host.querySelector('h2')?.textContent).toBe('Insert link');
    expect(host.querySelectorAll<HTMLInputElement>('input')[0].value).toBe('文件');
    expect(host.querySelectorAll<HTMLInputElement>('input')[1].value).toBe('./文件/保存.md');
    click(host.querySelector('button[type="submit"]'));
    expect(insert).toHaveBeenCalledWith('[文件](<./文件/保存.md>)');
  });
  it('translates reader controls and diff labels while preserving document content', () => {
    const content =
      '# 文件\n\n保存与编辑\n\n- [x] 已完成的正文\n\n![图片](https://example.com/保存.png)';
    act(() => root.render(createElement(Reader, { content, onLink: vi.fn() })));
    expect(host.querySelector('.remote-image-load')?.textContent).toContain('加载网络图片');
    act(() => setLanguage('en'));
    expect(host.querySelector('h1')?.textContent).toBe('文件');
    expect(host.querySelector('p')?.textContent).toBe('保存与编辑');
    expect(host.querySelector('img')?.getAttribute('alt')).toBe('图片');
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(host.querySelector('.remote-image-load')?.textContent).toContain('Load remote image');
    expect(host.querySelector('.remote-image-load')?.textContent).toContain('example.com');
    expect(host.querySelector('.task-check')?.getAttribute('aria-label')).toBe('Complete');
    expect(host.querySelector('li')?.textContent).toContain('已完成的正文');
    act(() => root.render(createElement(DiffView, { before: '文件\n', after: '文件\n保存\n' })));
    expect(host.querySelector('pre')?.getAttribute('aria-label')).toBe('Version differences');
    expect(host.querySelector('pre')?.textContent).toContain('文件');
    expect(host.querySelector('pre')?.textContent).toContain('保存');
  });
  it('opens a Chinese desktop menu, operates with arrow keys, and invokes a real action', async () => {
    const action = vi.fn();
    act(() =>
      root.render(
        createElement(EditingMenu, {
          onAction: action,
          mode: 'live',
          theme: 'system',
          focus: false,
        }),
      ),
    );
    const format = [
      ...host.querySelectorAll<HTMLButtonElement>('[role="menubar"]>.editing-menu-group>button'),
    ].find((button) => button.textContent === '格式')!;
    act(() => {
      format.focus();
      format.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement?.textContent).toContain('粗体');
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.activeElement?.textContent).toContain('斜体');
    click(document.activeElement);
    expect(action).toHaveBeenCalledWith('format:italic');
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('dismisses menus with Escape and returns focus to their title', () => {
    act(() =>
      root.render(
        createElement(EditingMenu, {
          onAction: vi.fn(),
          mode: 'source',
          theme: 'dark',
          focus: false,
        }),
      ),
    );
    const file = host.querySelector<HTMLButtonElement>('.editing-menu-group>button')!;
    click(file);
    act(() =>
      host
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(file);
  });
  it('pastes spreadsheet cells into a grid and submits an aligned Markdown table', () => {
    const insert = vi.fn();
    act(() =>
      root.render(
        createElement(InsertDialog, { kind: 'table', onClose: vi.fn(), onInsert: insert }),
      ),
    );
    const cell = host.querySelector<HTMLInputElement>('input[aria-label="第 1 行第 1 列"]')!;
    act(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => '苹果\t12\n橙子\t8' },
      });
      cell.dispatchEvent(event);
    });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="第 2 行第 1 列"]')?.value).toBe(
      '橙子',
    );
    change(host.querySelector<HTMLSelectElement>('select[aria-label="第 2 列对齐"]')!, 'right');
    click(host.querySelector('button[type="submit"]'));
    expect(insert).toHaveBeenCalledWith(
      '| 标题一 | 标题二 |\n| --- | ---: |\n| 苹果 | 12 |\n| 橙子 | 8 |',
    );
  });
  it('offers a file picker for images and a no-path-typing document link selector', () => {
    const image = vi.fn();
    const insert = vi.fn();
    act(() =>
      root.render(
        createElement(InsertDialog, {
          kind: 'image',
          onClose: vi.fn(),
          onInsert: insert,
          onChooseImage: image,
        }),
      ),
    );
    click(host.querySelector('.insert-file-button'));
    expect(image).toHaveBeenCalledOnce();
    act(() =>
      root.render(
        createElement(InsertDialog, {
          key: 'link',
          kind: 'link',
          onClose: vi.fn(),
          onInsert: insert,
          documents: [{ name: '说明.md', path: './文档/说明.md' }],
        }),
      ),
    );
    change(host.querySelector('select')!, './文档/说明.md');
    click(host.querySelector('button[type="submit"]'));
    expect(insert).toHaveBeenCalledWith('[说明](<./文档/说明.md>)');
  });
  it('rejects active URL schemes and gives a visible correction message', () => {
    const insert = vi.fn();
    act(() =>
      root.render(
        createElement(InsertDialog, { kind: 'link', onClose: vi.fn(), onInsert: insert }),
      ),
    );
    change(host.querySelectorAll<HTMLInputElement>('input')[1], 'javascript:alert(1)');
    click(host.querySelector('button[type="submit"]'));
    expect(insert).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('网页地址');
  });
  it('inserts a flowchart from plain-language steps without Markdown input', () => {
    const insert = vi.fn();
    act(() =>
      root.render(
        createElement(InsertDialog, { kind: 'mermaid', onClose: vi.fn(), onInsert: insert }),
      ),
    );
    change(host.querySelector('textarea')!, '打开文档\n写作\n保存');
    click(host.querySelector('button[type="submit"]'));
    expect(insert).toHaveBeenCalledWith(
      '\n\n```mermaid\nflowchart TD\n  step0["打开文档"]\n  step1["写作"]\n  step2["保存"]\n  step0 --> step1\n  step1 --> step2\n```\n\n',
    );
  });
});
