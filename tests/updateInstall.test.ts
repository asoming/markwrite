import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLanguage } from '../src/lib/i18n';
const native = vi.hoisted(() => ({ invoke: vi.fn(), close: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => false }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: native.close }) }));
vi.mock('../src/lib/platform', async (original) => ({
  ...(await original<typeof import('../src/lib/platform')>()),
  desktop: false,
}));
vi.mock('../src/editor/lazyEditor', async (original) => ({
  ...(await original<typeof import('../src/editor/lazyEditor')>()),
  default: ({ content }: { content: string }) => createElement('pre', {}, content),
  releaseEditor: vi.fn(),
}));
vi.mock('../src/Reader', () => ({
  default: ({ content }: { content: string }) => createElement('article', {}, content),
}));
vi.mock('../src/lib/useDocumentStats', () => ({
  useDocumentStats: () => ({ headings: [], words: 0 }),
}));
// The verified-download UI has its own test; exercise its callback through the real App close flow.
vi.mock('../src/components/SettingsPanel', () => ({
  default: ({ onInstallUpdate }: { onInstallUpdate: (name: string) => void }) =>
    createElement(
      'button',
      { onClick: () => onInstallUpdate('Markwrite_1.2.0_amd64.deb') },
      'Install fixture',
    ),
}));
import App from '../src/App';
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  setLanguage('en');
  native.invoke.mockReset();
  native.close.mockReset();
  native.invoke.mockResolvedValue('portable-updated');
  native.close.mockResolvedValue(undefined);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(App)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  setLanguage('zh-CN');
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (node) => (node.getAttribute('aria-label') || node.textContent?.trim()) === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function startInstall() {
  await act(async () =>
    (host.querySelector('.sidebar-bottom button') as HTMLButtonElement).click(),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  await click('Install fixture');
  expect(host.textContent).toContain('安装更新前');
}
it('cancels before starting the installer or closing the application', async () => {
  await startInstall();
  await click('取消');
  expect(native.invoke).not.toHaveBeenCalledWith('install_app_update', expect.anything());
  expect(native.close).not.toHaveBeenCalled();
});
it('persists the chosen draft session before installing, then closes only after installation succeeds', async () => {
  native.invoke.mockImplementation(async (command) => {
    if (command === 'install_app_update') {
      expect(localStorage.getItem('markwrite.session.v1')).not.toBeNull();
      expect(native.close).not.toHaveBeenCalled();
    }
    return 'portable-updated';
  });
  await startInstall();
  await click('保留草稿并退出');
  expect(native.invoke).toHaveBeenCalledWith('install_app_update', {
    name: 'Markwrite_1.2.0_amd64.deb',
  });
  expect(native.close).toHaveBeenCalledOnce();
});
it('keeps the application and recovery session when installation fails after a discard choice', async () => {
  native.invoke.mockRejectedValue(new Error('Installer verification failed'));
  await startInstall();
  await click('不保存并退出');
  expect(native.close).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Installer verification failed');
  expect(localStorage.getItem('markwrite.session.v1')).not.toBeNull();
  expect(host.querySelector('[aria-busy=true]')).toBeNull();
});
