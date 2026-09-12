import { act, createElement, createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ComparePane, { type CompareHandle } from '../src/components/ComparePane';
import { defaultSettings } from '../src/lib/recovery';
import { releaseEditor } from '../src/editor/lazyEditor';
import type { Document, Mode } from '../src/lib/types';
import { synchronizeScroll } from '../src/lib/linkedScroll';

it('edits and undoes the right buffer and routes save without touching the other document', async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const control = createRef<CompareHandle>();
  const save = vi.fn();
  const id = crypto.randomUUID();
  const left = '# Left unchanged';
  let latest = '# Right';
  const doc: Document = {
    id,
    name: 'right.md',
    content: latest,
    saved: latest,
    bom: false,
    crlf: false,
    status: 'clean',
    updated: 0,
  };
  function Harness() {
    const [mode, setMode] = useState<Mode>('source');
    const [content, setContent] = useState(latest);
    return createElement(ComparePane, {
      ref: control,
      document: { ...doc, content },
      documents: [doc],
      mode,
      settings: defaultSettings,
      revision: 0,
      onMode: setMode,
      onChange: (text) => {
        latest = text;
        setContent(text);
      },
      onSave: save,
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onDocumentClose: vi.fn(),
      onInsert: vi.fn(),
      onImage: vi.fn(),
      onComposition: vi.fn(),
      onLink: vi.fn(),
      onFocused: vi.fn(),
      linked: false,
      onLinked: vi.fn(),
    });
  }
  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(control.current?.view).toBeTruthy();
    });
    act(() => {
      control.current!.view!.dispatch({ selection: { anchor: 2, head: 7 } });
      control.current!.action('format:bold');
    });
    expect(latest).toBe('# **Right**');
    expect(left).toBe('# Left unchanged');
    act(() => {
      control.current!.action('app:undo');
    });
    expect(latest).toBe('# Right');
    act(() => {
      control.current!.action('app:redo');
      control.current!.action('app:save');
    });
    expect(latest).toBe('# **Right**');
    expect(save).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    releaseEditor(`compare:${id}`);
    host.remove();
    vi.unstubAllGlobals();
  }
});
it('synchronizes relative scroll progress and handles short targets', () => {
  const a = document.createElement('div'),
    b = document.createElement('div');
  Object.defineProperties(a, { scrollHeight: { value: 2100 }, clientHeight: { value: 100 } });
  Object.defineProperties(b, {
    scrollHeight: { value: 4200, configurable: true },
    clientHeight: { value: 200 },
  });
  a.scrollTop = 1000;
  expect(synchronizeScroll(a, b)).toBe(2000);
  Object.defineProperty(b, 'scrollHeight', { value: 100 });
  expect(synchronizeScroll(a, b)).toBe(0);
});
