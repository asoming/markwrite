import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/lib/platform', () => ({ desktop: true }));
import AiPanel from '../src/components/AiPanel';
import { setLanguage } from '../src/lib/i18n';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLanguage('en');
  localStorage.clear();
  mocks.invoke.mockReset();
  localStorage.setItem(
    'markwrite.ai.connection.v1',
    JSON.stringify({
      endpoint: 'https://provider.test/v1',
      model: 'fixture-model',
      protocol: 'chat',
    }),
  );
  mocks.invoke.mockImplementation(async (command) =>
    command === 'ai_load_key' ? 'stored-key' : { text: 'Revised text' },
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  setLanguage('zh-CN');
});
async function render(selection = '', onApply = vi.fn()) {
  await act(async () => root.render(createElement(AiPanel, { selection, onApply })));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 350));
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((n) => n.textContent?.includes(label));
  expect(button).toBeTruthy();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
it('loads a remembered key and tests without sending selected text or storing the key in localStorage', async () => {
  await render('private selected text');
  expect(mocks.invoke).toHaveBeenCalledWith('ai_load_key', {
    endpoint: 'https://provider.test/v1/chat/completions',
  });
  expect(
    mocks.invoke.mock.calls.some(([c]) => c === 'ai_transform' || c === 'ai_test_connection'),
  ).toBe(false);
  await click('Test connection');
  const request = mocks.invoke.mock.calls.find(([c]) => c === 'ai_test_connection')![1].request;
  expect(request.selection).toBeUndefined();
  expect(request.instruction).toBeUndefined();
  expect(request.apiKey).toBe('stored-key');
  expect(JSON.stringify(localStorage)).not.toContain('stored-key');
  expect(host.textContent).toContain('Connected.');
});
it('can test without a selection, explains disabled generation, and deletes saved credentials', async () => {
  await render();
  expect(host.textContent).toContain('No text selected');
  expect(
    [...host.querySelectorAll('button')].find((n) => n.textContent?.includes('Send and preview'))
      ?.disabled,
  ).toBe(true);
  await click('Test connection');
  await click('Delete saved key');
  expect(mocks.invoke).toHaveBeenCalledWith('ai_delete_key', {
    endpoint: 'https://provider.test/v1/chat/completions',
  });
  expect((host.querySelector('input[type=password]') as HTMLInputElement).value).toBe('');
});
it('requires explicit acceptance and shows a route error rather than applying failed output', async () => {
  const apply = vi.fn();
  await render('Original', apply);
  await click('Send and preview');
  expect(apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Revised text');
  await click('Accept changes');
  expect(apply).toHaveBeenCalledWith('Revised text');
  mocks.invoke.mockImplementation(async (c) => {
    if (c === 'ai_transform') throw new Error('HTTP 404 · API route or model not found');
    return null;
  });
  await click('Send and preview');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('404');
  expect(host.textContent).not.toContain('Accept changes');
});
