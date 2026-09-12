import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareRichClipboard, writeRichClipboard } from '../src/lib/richClipboard';
import { renderMarkdown } from '../src/lib/markdown';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=';
function article(source: string) {
  const node = document.createElement('article');
  node.innerHTML = renderMarkdown(source);
  return node;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('offline rich-text clipboard', () => {
  it('preserves paragraphs, lists, tables, links and footnotes with inline formatting and plain text', async () => {
    const source =
      '# 介绍\n\nA **bold** sentence and [site](https://example.com).[^n]\n\n- [x] 完成\n- next\n\n| A | B |\n| :- | -: |\n| 中文 | 123 |\n\n[^n]: 脚注 text.';
    const payload = await prepareRichClipboard(article(source), {
      target: 'wechat',
      title: '介绍',
    });
    const host = document.createElement('div');
    host.innerHTML = payload.html;
    expect(host.querySelector('h1')?.textContent).toBe('介绍');
    expect(host.querySelector('strong')?.style.fontWeight).toBe('700');
    expect(host.querySelectorAll('table tr')).toHaveLength(2);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(payload.text).toContain('A bold sentence');
    expect(payload.text).toContain('[x] 完成');
    expect(payload.text).toContain('脚注 text.');
    expect(payload.html).not.toContain('data-');
    expect(payload.warnings).toHaveLength(0);
  });
  it('locally rasterizes formulas and diagrams without changing source or losing inline order', async () => {
    const node = article(
      'Before $x^2$ after.\n\n$$\n\\frac{a}{b}\n$$\n\n```mermaid\ngraph LR; A-->B\n```',
    );
    node.querySelector('.diagram')!.innerHTML =
      '<svg width="100" height="50" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>';
    const original = node.innerHTML;
    const raster = vi.fn(async () => ({ source: png, width: 100, height: 50 }));
    const payload = await prepareRichClipboard(node, { target: 'feishu', title: 'Export' }, raster);
    const host = document.createElement('div');
    host.innerHTML = payload.html;
    expect(raster).toHaveBeenCalledTimes(3);
    expect(host.querySelector('p')?.innerHTML).toMatch(/^Before <img[^>]+> after\.$/);
    expect(host.querySelector('svg,[data-tex],[data-diagram]')).toBeNull();
    expect(payload.imageCount).toBe(3);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.text).toContain('$x^2$');
    expect(payload.text).toContain('```mermaid\ngraph LR; A-->B');
    expect(node.innerHTML).toBe(original);
  });
  it('rejects missing assets and invalid formulas rather than copying an incomplete article', async () => {
    await expect(
      prepareRichClipboard(article('![missing](missing.png)'), { target: 'wechat', title: 'x' }),
    ).rejects.toThrow('尚未加载');
    await expect(
      prepareRichClipboard(article('$\\notACommand$'), { target: 'wechat', title: 'x' }),
    ).rejects.toThrow('错误');
  });
  it('writes HTML and plain-text clipboard flavors in one transaction', async () => {
    const write = vi.fn(async (_items: unknown[]) => {});
    class Item {
      constructor(public data: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', Item);
    vi.stubGlobal('navigator', { clipboard: { write } });
    await writeRichClipboard({ html: '<p>中文</p>', text: '中文' });
    const item = write.mock.calls[0]?.[0] as unknown as Item[];
    expect(Object.keys(item[0].data)).toEqual(['text/html', 'text/plain']);
  });
  it('uses WebKit copy events without selecting or modifying the document', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const setData = vi.fn();
    const html = document.body.innerHTML;
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        const event = new Event('copy', { cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { setData } });
        document.dispatchEvent(event);
        return true;
      }),
    });
    await writeRichClipboard({ html: '<p>safe</p>', text: 'safe' });
    expect(setData.mock.calls).toEqual([
      ['text/html', '<p>safe</p>'],
      ['text/plain', 'safe'],
    ]);
    expect(document.body.innerHTML).toBe(html);
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
});
