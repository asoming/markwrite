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
