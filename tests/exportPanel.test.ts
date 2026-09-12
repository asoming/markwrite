import { act, createElement, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExportOptionsPanel, { type ExportPanelOptions } from '../src/components/ExportOptionsPanel';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  build: vi.fn(),
  save: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock('../src/lib/export', async (original) => ({
  ...(await original<typeof import('../src/lib/export')>()),
  collectExportBlocks: mocks.collect,
  buildPdf: mocks.build,
  saveExportBytes: mocks.save,
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: mocks.getDocument,
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: '/local-pdf-worker.mjs',
}));

let host: HTMLDivElement;
let root: Root;
let pdf: ReturnType<typeof fakePdf>;
function fakePdf() {
  return {
    numPages: 3,
    loadingTask: { destroy: vi.fn(async () => {}) },
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 419.53 * scale,
        height: 595.28 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    })),
  };
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  pdf = fakePdf();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  mocks.collect.mockResolvedValue([
    { kind: 'paragraph', runs: [{ kind: 'text', text: 'Current document' }] },
  ]);
  mocks.build.mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45]));
  mocks.save.mockResolvedValue(true);
  mocks.getDocument.mockImplementation(({ data }: { data: Uint8Array }) => {
    // Simulate worker ownership of its input without corrupting the bytes we save.
    data.fill(0);
    return { promise: Promise.resolve(pdf) };
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => (item.getAttribute('aria-label') || item.textContent) === name,
  );
  expect(found, name).toBeDefined();
  return found!;
}
async function click(name: string) {
  await act(async () => {
    button(name).click();
  });
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function renderPanel(
  initial: ExportPanelOptions = {},
  prepare = vi.fn(async () => document.createElement('article')),
) {
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    return createElement(ExportOptionsPanel, {
      format: 'pdf',
      title: 'Current.md',
      language: 'en',
      value,
      onChange: (next) => {
        latest = next;
        setValue(next);
      },
      prepareArticle: prepare,
      sourceKey: 'document:v1',
    });
  }
  act(() => root.render(createElement(Harness)));
  return { prepare, options: () => latest };
}
function select(label: string, value: string) {
  const node = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(node).toBeDefined();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value);
    node!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('export layout and real-PDF preview controls', () => {
  it('passes the current layout and hydrated content to PDF generation and saves the exact preview bytes', async () => {
    const { prepare } = renderPanel({ paper: 'A5', toc: true, cover: true, header: 'Review' });
    await click('Generate PDF preview');
    await vi.waitFor(async () => {
      await settle();
      expect(host.querySelector('canvas')).not.toBeNull();
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledWith(
      expect.any(Array),
      'Current.md',
      expect.objectContaining({
        paper: 'A5',
        toc: true,
        cover: true,
        header: 'Review',
        language: 'en',
      }),
    );
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    await click('Next page');
    await settle();
    expect(pdf.getPage).toHaveBeenLastCalledWith(2);
    await click('Save PDF for printing');
    expect(mocks.save).toHaveBeenCalledWith(
      'pdf',
      new Uint8Array([37, 80, 68, 70, 45]),
      'Current.md',
    );
    expect(host.textContent).toContain('Open it in your system PDF reader');
  });

  it('discards an obsolete generation after layout changes, rather than showing or saving stale output', async () => {
    let resolve: (bytes: Uint8Array) => void = () => {};
    mocks.build.mockReturnValueOnce(
      new Promise<Uint8Array>((done) => {
        resolve = done;
      }),
    );
    const panel = renderPanel({ paper: 'A4' });
    await click('Generate PDF preview');
    expect(mocks.build).toHaveBeenCalledOnce();
    select('Paper size', 'LETTER');
    expect(panel.options().paper).toBe('LETTER');
    await act(async () => {
      resolve(new Uint8Array([37, 80, 68, 70]));
    });
    expect(mocks.getDocument).not.toHaveBeenCalled();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.textContent).not.toContain('Save PDF for printing');
    expect(button('Generate PDF preview').disabled).toBe(false);
  });

  it('releases the rendered document when the options change', async () => {
    renderPanel();
    await click('Generate PDF preview');
    await vi.waitFor(async () => {
      await settle();
      expect(host.querySelector('canvas')).not.toBeNull();
    });
    select('Paper size', 'A5');
    expect(pdf.loadingTask.destroy).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.textContent).not.toContain('Save PDF for printing');
  });

  it('hides an old PDF in the same render that applies new options, before effect cleanup', async () => {
    const observed: Array<{ canvas: boolean; save: boolean }> = [];
    function Harness() {
      const [value, setValue] = useState<ExportPanelOptions>({ paper: 'A4' });
      useLayoutEffect(() => {
        if (value.paper === 'LETTER')
          observed.push({
            canvas: Boolean(host.querySelector('canvas')),
            save: Boolean(host.textContent?.includes('Save PDF for printing')),
          });
      }, [value.paper]);
      return createElement(ExportOptionsPanel, {
        format: 'pdf',
        title: 'Current.md',
        language: 'en',
        value,
        onChange: setValue,
        prepareArticle: async () => document.createElement('article'),
        sourceKey: 'document:v1',
      });
    }
    act(() => root.render(createElement(Harness)));
    await click('Generate PDF preview');
    await vi.waitFor(async () => {
      await settle();
      expect(host.querySelector('canvas')).not.toBeNull();
    });
    select('Paper size', 'LETTER');
    expect(observed).toEqual([{ canvas: false, save: false }]);
  });

  it('shows preparation errors and does not offer an empty PDF as a preview', async () => {
    renderPanel(
      {},
      vi.fn(async () => {
        throw new Error('Missing local image');
      }),
    );
    await click('Generate PDF preview');
    expect(host.querySelector('[role=alert]')?.textContent).toBe('Missing local image');
    expect(mocks.build).not.toHaveBeenCalled();
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.textContent).not.toContain('Save PDF for printing');
  });
});
