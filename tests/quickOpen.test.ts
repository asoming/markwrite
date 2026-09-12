import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useQuickOpenFiles } from '../src/lib/useQuickOpenFiles';
const findFiles = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/platform', () => ({ findFiles }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
function View({ active, path, query }: { active: boolean; path: string; query: string }) {
  return createElement('pre', null, JSON.stringify(useQuickOpenFiles(active, path, query)));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  findFiles.mockReset();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
it('does no startup scan and cancels stale queries and closed panels', async () => {
  const resolves: ((files: unknown) => void)[] = [];
  findFiles.mockImplementation(() => new Promise((resolve) => resolves.push(resolve)));
  await act(async () =>
    root.render(createElement(View, { active: false, path: '/repo', query: '' })),
  );
  await act(async () => vi.advanceTimersByTime(500));
  expect(findFiles).not.toHaveBeenCalled();
  await act(async () =>
    root.render(createElement(View, { active: true, path: '/repo', query: 'old' })),
  );
  await act(async () => vi.advanceTimersByTime(150));
  const signal = findFiles.mock.calls[0][3];
  await act(async () =>
    root.render(createElement(View, { active: true, path: '/repo', query: 'new' })),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTime(150));
  await act(async () => resolves[1]([{ name: 'new.md', path: '/repo/深层/new.md' }]));
  await act(async () => resolves[0]([{ name: 'old.md', path: '/repo/old.md' }]));
  expect(host.textContent).toContain('深层/new.md');
  expect(host.textContent).not.toContain('old.md');
  await act(async () =>
    root.render(createElement(View, { active: false, path: '/repo', query: '' })),
  );
  expect(findFiles.mock.calls[1][3].aborted).toBe(true);
  expect(host.textContent).not.toContain('new.md');
});
