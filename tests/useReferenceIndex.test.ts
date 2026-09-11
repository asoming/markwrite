import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferenceIndex } from '../src/lib/useReferenceIndex';
import { emptyReferences } from '../src/lib/referenceIndex';
import type { IndexedDocument } from '../src/lib/workspace';
import type { IndexRequest } from '../src/lib/references.worker';

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: IndexRequest[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((request: IndexRequest) => this.sent.push(request));
  constructor() {
    FakeWorker.all.push(this);
  }
  reply(id: number, documents: number) {
    this.onmessage?.({ data: { id, result: { ...emptyReferences(), documents } } } as MessageEvent);
  }
}
let host: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useReferenceIndex>;
type Props = {
  disk: IndexedDocument[];
  buffers: IndexedDocument[];
  path: string;
  enabled: boolean;
};
function Harness(p: Props) {
  latest = useReferenceIndex(p.disk, p.buffers, p.path, p.enabled);
  return null;
}
const doc = (path: string, content = '') => ({ path, content });
let props: Props;
function render(next: Partial<Props> = {}, strict = false) {
  props = { ...props, ...next };
  act(() =>
    root.render(
      strict
        ? createElement(StrictMode, {}, createElement(Harness, props))
        : createElement(Harness, props),
    ),
  );
}
function tick(ms = 150) {
  act(() => vi.advanceTimersByTime(ms));
}
const worker = () => FakeWorker.all.at(-1)!;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.all = [];
  props = { disk: [doc('/notes/a.md')], buffers: [], path: '/notes/a.md', enabled: true };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reference worker lifecycle', () => {
  it('coalesces queued edits without losing a newer disk snapshot or accepting old/duplicate replies', () => {
    render();
    tick();
    const first = worker().sent[0];
    const disk = [doc('/next/b.md')];
    render({ disk, path: '/next/b.md' });
    tick();
    const buffers = [doc('/next/b.md', '# Changed')];
    render({ buffers });
    tick();
    expect(worker().sent).toHaveLength(1);
    act(() => worker().reply(first.id, 1));
    expect(latest.result.documents).toBe(0);
    const second = worker().sent[1];
    expect(second.disk).toBe(disk);
    expect(second.buffers).toBe(buffers);
    act(() => worker().reply(first.id, 999));
    expect(latest.pending).toBe(true);
    act(() => worker().reply(second.id, 2));
    expect(latest.result.documents).toBe(2);
    expect(latest.pending).toBe(false);
    render({ buffers: [...buffers] });
    tick();
    expect(worker().sent).toHaveLength(2);
  });
  it('drops a hidden-tab queue and re-enables from the complete latest snapshot', () => {
    render();
    tick();
    const first = worker().sent[0];
    const disk = [doc('/next/b.md')];
    render({ disk, path: '/next/b.md' });
    tick();
    render({ enabled: false });
    tick();
    expect(latest.pending).toBe(false);
    act(() => worker().reply(first.id, 99));
    expect(latest.result.documents).toBe(0);
    expect(worker().sent).toHaveLength(1);
    render({ enabled: true });
    tick();
    expect(worker().sent[1].disk).toBe(disk);
    act(() => worker().reply(worker().sent[1].id, 2));
    expect(latest.result.documents).toBe(2);
  });
  it('clears data immediately on current-file changes and accepts only the final debounced query', () => {
    render();
    tick();
    act(() => worker().reply(worker().sent[0].id, 1));
    expect(latest.result.documents).toBe(1);
    render({ path: '/notes/b.md' });
    expect(latest.result.documents).toBe(0);
    render({ path: '/notes/c.md' });
    tick();
    expect(worker().sent).toHaveLength(2);
    expect(worker().sent[1].currentPath).toBe('/notes/c.md');
    expect(worker().sent[1].disk).toBeUndefined();
  });
  it('terminates crashed workers, discards their queues, and ignores already-delivered callbacks', () => {
    render();
    tick();
    const broken = worker(),
      callback = broken.onmessage;
    render({ buffers: [doc('/notes/a.md', '# Latest')] });
    tick();
    act(() => broken.onerror?.());
    expect(latest.pending).toBe(false);
    expect(latest.error).toContain('Background index failed');
    expect(broken.terminate).toHaveBeenCalledOnce();
    act(() =>
      callback?.({
        data: { id: broken.sent[0].id, result: { ...emptyReferences(), documents: 999 } },
      } as MessageEvent),
    );
    expect(latest.result.documents).toBe(0);
    expect(broken.sent).toHaveLength(1);
  });
  it('reports synchronous postMessage failures rather than leaving an indefinite loading state', () => {
    render();
    worker().postMessage.mockImplementation(() => {
      throw new Error('Clone failed');
    });
    tick();
    expect(latest.pending).toBe(false);
    expect(latest.error).toContain('Clone failed');
    expect(worker().terminate).toHaveBeenCalledOnce();
  });
  it('restarts with a fresh snapshot after StrictMode teardown and ignores the disposed worker', () => {
    render({}, true);
    tick();
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.all[0].sent).toHaveLength(0);
    expect(worker().sent[0].disk).toBe(props.disk);
    act(() => worker().reply(worker().sent[0].id, 1));
    expect(latest.result.documents).toBe(1);
  });
});
