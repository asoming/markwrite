// Opt-in diagnostic: MARKWRITE_BENCHMARK=1 npm test -- --run tests/editor-performance.test.ts
// Measures the real Editor component in jsdom. It excludes App indexing, browser paint,
// WebKit/Windows startup, disk I/O, and IME, so these results are not desktop acceptance.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import Editor, { releaseEditor } from '../src/editor/Editor';
import { getHeadings, wordCount } from '../src/lib/markdown';

describe.skipIf(process.env.MARKWRITE_BENCHMARK !== '1')('editor diagnostic benchmark', () => {
  for (const megabytes of [1, 10])
    it(`${megabytes} MiB mixed Markdown opens and preserves edits`, () => {
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        setTimeout(() => callback(0), 16),
      );
      vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
      Object.defineProperty(Range.prototype, 'getClientRects', {
        configurable: true,
        value: () => [],
      });
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(),
      });
      const sample = '- 项目：**编辑性能** mixed Markdown line 0123456789\n';
      const bytes = new TextEncoder().encode(sample).length;
      const content = sample.repeat(Math.ceil((megabytes * 1024 * 1024) / bytes));
      const indexStart = performance.now();
      const headings = getHeadings(content);
      const outlineMs = performance.now() - indexStart;
      const countStart = performance.now();
      const words = wordCount(content);
      const countMs = performance.now() - countStart;
      console.info(
        'MARKWRITE_INDEX_BENCHMARK ' +
          JSON.stringify({
            megabytes,
            headings: headings.length,
            words,
            outlineMs: Number(outlineMs.toFixed(2)),
            wordCountMs: Number(countMs.toFixed(2)),
          }),
      );
      const id = crypto.randomUUID();
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      let editor: EditorView | undefined;
      const start = performance.now();
      try {
        act(() =>
          root.render(
            createElement(Editor, {
              id,
              content,
              mode: 'live',
              onChange: () => {},
              onReady: (view) => {
                editor = view || undefined;
              },
              onSelection: () => {},
              onImage: () => {},
              onComposition: () => {},
            }),
          ),
        );
        const mountMs = performance.now() - start;
        expect(editor).toBeDefined();
        expect(editor!.state.doc.toString()).toBe(content);
        const intervals: number[] = [];
        for (let n = 0; n < 50; n++) {
          const before = performance.now();
          editor!.dispatch({
            changes: { from: editor!.state.doc.length, insert: '字' },
            selection: { anchor: editor!.state.doc.length + 1 },
            userEvent: 'input.type',
          });
          intervals.push(performance.now() - before);
        }
        const sorted = [...intervals].sort((a, b) => a - b);
        expect(editor!.state.doc.toString()).toBe(content + '字'.repeat(50));
        console.info(
          'MARKWRITE_EDITOR_BENCHMARK ' +
            JSON.stringify({
              environment: 'Node/jsdom; excludes App, native WebView, paint, disk and IME',
              megabytes,
              utf8Bytes: new TextEncoder().encode(content).length,
              codeUnits: content.length,
              lines: editor!.state.doc.lines,
              mountMs: Number(mountMs.toFixed(2)),
              editP50Ms: Number(sorted[24].toFixed(2)),
              editP95Ms: Number(sorted[47].toFixed(2)),
              maxEditMs: Number(sorted[49].toFixed(2)),
            }),
        );
      } finally {
        act(() => root.unmount());
        releaseEditor(id);
        host.remove();
        vi.unstubAllGlobals();
      }
    }, 30_000);
});
