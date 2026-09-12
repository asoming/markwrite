import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import Reader, { type ReaderHandle } from '../src/Reader';
import { ReadingDocument } from '../src/lib/readingDocument';
import { prepareReadingClipboard } from '../src/lib/readingClipboard';

describe('copying the entire virtual document', () => {
  it('copies original complete tables once, preserves their plain-text structure and strips unsafe markup', async () => {
    const document = new ReadingDocument(
      '| Name | Value |\n| --- | --- |\n' +
        Array.from({ length: 200 }, (_, index) => `| row${index} | **value${index}** |`).join(
          '\n',
        ) +
        '\n\n<script>bad()</script>\n\n<img src="bad" onerror="bad()">',
    );
    expect(document.blocks.length).toBeGreaterThan(4);
    const result = await prepareReadingClipboard(document.clipboardParts);
    expect(result.html.match(/<table>/g)).toHaveLength(1);
    expect(result.html.match(/<tr>/g)).toHaveLength(201);
    expect(result.text).toContain('Name\tValue');
    expect(result.text).toContain('row199\tvalue199');
    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('onerror');
    expect(result.text).not.toContain('bad()');
  });
  it('keeps intentional blank lines inside copied code', async () => {
    const document = new ReadingDocument('```text\nfirst\n\n\nlast\n```');
    const result = await prepareReadingClipboard(document.clipboardParts);
    expect(result.text).toContain('first\n\n\nlast');
  });
  it('cancels preparation after a file changes instead of copying a stale document', async () => {
    await expect(prepareReadingClipboard(['<p>old</p>'], () => true)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  it('handles a real copy event using every paragraph, while ordinary selected text keeps native copy behavior', async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host),
      ref = createRef<ReaderHandle>(),
      ready = vi.fn();
    const content = Array.from({ length: 1000 }, (_, index) => `段落 ${index} **强调**。`).join(
      '\n\n',
    );
    try {
      await act(async () =>
        root.render(createElement(Reader, { content, ref, onLink: vi.fn(), onReady: ready })),
      );
      await act(async () =>
        root.render(createElement(Reader, { content, ref, onLink: vi.fn(), onReady: vi.fn() })),
      );
      expect(ready).toHaveBeenCalledTimes(1);
      await act(async () => ref.current!.selectAll());
      await vi.waitFor(
        async () => {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
          });
          expect(host.querySelector('.reading-copy-status')?.textContent).toContain('全文已准备');
        },
        { timeout: 5000 },
      );
      const data = new Map<string, string>();
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (type: string, value: string) => data.set(type, value) },
      });
      act(() => document.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(data.get('text/plain')).toContain('段落 999 强调');
      expect(data.get('text/html')?.match(/<p>/g)).toHaveLength(1000);
      expect(host.querySelectorAll('.reading-block').length).toBeLessThan(100);
      act(() =>
        host
          .querySelector('.reader-scroll')!
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })),
      );
      const ordinary = new Event('copy', { bubbles: true, cancelable: true });
      act(() => host.querySelector('.reader-scroll')!.dispatchEvent(ordinary));
      expect(ordinary.defaultPrevented).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
      window.getSelection()?.removeAllRanges();
    }
  });
});
