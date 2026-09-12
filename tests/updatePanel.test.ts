import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openExternal: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../src/lib/platform', () => ({ desktop: true, openExternal: mocks.openExternal }));
import UpdatePanel from '../src/components/UpdatePanel';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset();
  mocks.openExternal.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});
async function render() {
  await act(async () => root.render(createElement(UpdatePanel, { language: 'en' })));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
it('checks only on request and offers a verified download without executing an installer', async () => {
  mocks.invoke.mockImplementation(async (command) =>
    command === 'check_app_update'
      ? {
          current: '0.4.0',
          latest: '0.5.0',
          available: true,
          releaseId: 5,
          notes: '<script>not HTML</script>',
          url: 'https://github.com/asoming/markwrite/releases',
          asset: { name: 'app.deb', size: 2048 },
        }
      : { path: '/updates/app.deb', name: 'app.deb', sha256: 'abc' },
  );
  await render();
  expect(mocks.invoke).not.toHaveBeenCalled();
  await click('Check for updates');
  expect(mocks.invoke).toHaveBeenCalledWith('check_app_update', { token: null, previews: false });
  expect(host.querySelector('script')).toBeNull();
  await click('Download installer');
  expect(mocks.invoke).toHaveBeenCalledWith('download_app_update', { releaseId: 5, token: null });
  expect(host.textContent).toContain('Save your work and quit');
  expect(localStorage.length).toBe(0);
  await click('Show installer folder');
  expect(mocks.invoke).toHaveBeenCalledWith('open_update_folder');
});
it('reports private access and verification failures without offering installation', async () => {
  mocks.invoke.mockRejectedValue(new Error('Private repository access required'));
  await render();
  await click('Check for updates');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Private repository');
  expect(host.textContent).not.toContain('Show installer folder');
});
