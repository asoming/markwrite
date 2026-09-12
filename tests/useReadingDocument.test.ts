import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useReadingDocument } from '../src/lib/useReadingDocument';
import Reader from '../src/Reader';
import type { ReadingRequest, ReadingResponse } from '../src/lib/reading.worker';
class WorkerMock {
  static instances: WorkerMock[] = [];
  messages: ReadingRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: ReadingResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    WorkerMock.instances.push(this);
  }
  postMessage(message: ReadingRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(response: ReadingResponse) {
    this.onmessage?.({ data: response });
  }
}
let host: HTMLDivElement, root: Root, model: ReturnType<typeof useReadingDocument>;
function Harness({
  text,
  name = 'a.md',
  revision = 0,
}: {
  text: string;
  name?: string;
  revision?: number;
}) {
  model = useReadingDocument(text, name, { compatibility: revision > 0 }, revision);
  return createElement('p', null, model.blocks.map((block) => block.excerpt).join(','));
}
async function render(text: string, name?: string, revision?: number) {
  await act(async () => root.render(createElement(Harness, { text, name, revision })));
}
function loaded(worker: WorkerMock, title: string, complete = true): ReadingResponse {
  const request = worker.messages[0];
  return {
    kind: 'loaded',
    generation: request.generation,
    complete,
    blocks: [
      {
        index: 0,
        fromLine: 1,
        toLine: 1,
        excerpt: title,
        characters: title.length,
        estimatedHeight: 70,
        anchors: [],
      },
    ],
    chunks: [{ index: 0, html: `<p>${title}</p>`, source: title }],
  };
}
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  WorkerMock.instances = [];
  vi.stubGlobal('Worker', WorkerMock);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
describe('reader worker request lifetimes', () => {
  it('queues a bookmark requested by onReady until the reading position is restored', async () => {
    localStorage.clear();
    await act(async () =>
      root.render(
        createElement(Reader, {
          content: 'text',
          path: '/pending.md',
          onLink: vi.fn(),
          onReady: (handle) => handle?.toggleBookmark(),
        }),
      ),
    );
    const worker = WorkerMock.instances[0];
    await act(async () => worker.reply(loaded(worker, 'text')));
    expect(
      JSON.parse(localStorage.getItem('markwrite.reading.v1:/pending.md')!).bookmarks,
    ).toHaveLength(1);
  });
  it('queues End until the complete document arrives and preserves Shift selection keys', async () => {
    localStorage.clear();
    await act(async () =>
      root.render(
        createElement(Reader, {
          content: 'long document',
          path: '/keyboard-end.md',
          onLink: vi.fn(),
        }),
      ),
    );
    const worker = WorkerMock.instances[0];
    await act(async () => worker.reply(loaded(worker, 'first', false)));
    const area = host.querySelector<HTMLElement>('.reader-scroll')!;
    const selectionKey = new KeyboardEvent('keydown', {
      key: 'End',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => area.dispatchEvent(selectionKey));
    expect(selectionKey.defaultPrevented).toBe(false);
    const endKey = new KeyboardEvent('keydown', {
      key: 'End',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => area.dispatchEvent(endKey));
    expect(endKey.defaultPrevented).toBe(true);
    const response = loaded(worker, 'first');
    if (response.kind !== 'loaded') throw new Error('Expected fixture load');
    response.blocks = Array.from({ length: 30 }, (_, index) => ({
      index,
      fromLine: index * 10 + 1,
      toLine: index * 10 + 9,
      excerpt: `block ${index}`,
      characters: 8,
      estimatedHeight: 400,
      anchors: [],
    }));
    await act(async () => worker.reply(response));
    expect(
      worker.messages.some((message) => message.kind === 'chunks' && message.indices.includes(29)),
    ).toBe(true);
    const homeKey = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    await act(async () => area.dispatchEvent(homeKey));
    expect(homeKey.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-reading-block="0"]')).not.toBeNull();
  });
  it('keeps End pinned while chunks settle and releases it on user scrolling', async () => {
    localStorage.clear();
    await act(async () =>
      root.render(
        createElement(Reader, {
          content: 'long document',
          path: '/keyboard-pin.md',
          onLink: vi.fn(),
        }),
      ),
    );
    const worker = WorkerMock.instances[0];
    const response = loaded(worker, 'first');
    if (response.kind !== 'loaded') throw new Error('Expected fixture load');
    response.blocks = Array.from({ length: 30 }, (_, index) => ({
      index,
      fromLine: index * 10 + 1,
      toLine: index * 10 + 9,
      excerpt: `block ${index}`,
      characters: 8,
      estimatedHeight: 400,
      anchors: [],
    }));
    await act(async () => worker.reply(response));
    const area = host.querySelector<HTMLElement>('.reader-scroll')!;
    let extent = 12000;
    Object.defineProperty(area, 'scrollHeight', { get: () => extent, configurable: true });
    await act(async () =>
      area.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    );
    await act(async () =>
      worker.reply({
        kind: 'chunks',
        generation: response.generation,
        chunks: [{ index: 29, html: '<p>last image block</p>', source: 'last image block' }],
      }),
    );
    expect(area.scrollTop).toBe(extent);
    await act(async () => {
      area.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      area.scrollTop = 4000;
    });
    extent = 14000;
    await act(async () =>
      worker.reply({
        kind: 'chunks',
        generation: response.generation,
        chunks: [
          { index: 28, html: '<p>late neighboring image</p>', source: 'late neighboring image' },
        ],
      }),
    );
    expect(area.scrollTop).toBe(4000);
  });
  it('terminates an old parse and ignores its late chunks after a file switch', async () => {
    await render('old');
    const first = WorkerMock.instances[0];
    await act(async () => first.reply(loaded(first, 'old')));
    await render('new', 'b.md');
    const second = WorkerMock.instances[1];
    expect(first.terminated).toBe(true);
    expect(host.textContent).not.toContain('old');
    await act(async () => {
      second.reply(loaded(second, 'new'));
      first.reply(loaded(first, 'stale'));
    });
    expect(host.textContent).toBe('new');
    expect(model.chunks.get(0)?.html).toBe('<p>new</p>');
  });
  it('keeps the latest search result when replies arrive in reverse order and does not reparse on scrolling', async () => {
    await render('text');
    const worker = WorkerMock.instances[0];
    await act(async () => worker.reply(loaded(worker, 'text')));
    act(() => {
      model.requestSearch('first');
      model.requestSearch('latest');
      model.requestChunks([0]);
    });
    const requests = worker.messages.filter(
      (request): request is Extract<ReadingRequest, { kind: 'search' }> =>
        request.kind === 'search',
    );
    await act(async () => {
      for (const request of [...requests].reverse())
        worker.reply({
          kind: 'search',
          generation: request.generation,
          request: request.request,
          result: {
            query: request.query,
            total: 1,
            index: 0,
            counts: [1],
            hit: { block: 0, from: 0, to: 1, line: 1 },
          },
        });
    });
    expect(model.search.query).toBe('latest');
    expect(model.searching).toBe(false);
    expect(worker.messages.filter((message) => message.kind === 'load')).toHaveLength(1);
  });
  it('reparses changed compatibility settings and surfaces a failed background parse without claiming the whole document loaded', async () => {
    await render('[[note]]');
    const first = WorkerMock.instances[0];
    await render('[[note]]', 'a.md', 1);
    const second = WorkerMock.instances[1];
    expect(first.terminated).toBe(true);
    expect(second.messages[0]).toMatchObject({ kind: 'load', options: { compatibility: true } });
    await act(async () => {
      second.reply(loaded(second, 'partial', false));
      second.onerror?.();
    });
    expect(model.error).toContain('未完全显示');
    expect(second.terminated).toBe(true);
    act(() => model.requestSearch('partial'));
    expect(model.searching).toBe(false);
  });
});
