import { afterEach, describe, expect, it, vi } from 'vitest';
import { macMenuOptions } from '../src/lib/macMenu';
import { setLanguage } from '../src/lib/i18n';
import { macPlatform } from '../src/lib/os';
import type { SubmenuOptions, MenuItemOptions } from '@tauri-apps/api/menu';
afterEach(() => {
  setLanguage('zh-CN');
  vi.restoreAllMocks();
});
describe('macOS native conventions', () => {
  it('detects Mac without treating Windows/Linux as macOS', () => {
    expect(macPlatform('MacIntel')).toBe(true);
    expect(macPlatform('Linux x86_64')).toBe(false);
    expect(macPlatform('Win32')).toBe(false);
  });
  it('routes Quit through the existing guarded close action and preserves system Hide/Services', () => {
    const action = vi.fn();
    setLanguage('en');
    const menu = macMenuOptions([], {}, 'read', 'github', false, action);
    const app = menu.items![0] as SubmenuOptions;
    const quit = app.items!.find((i) => 'id' in i && i.id === 'app:quit') as MenuItemOptions;
    expect(quit.accelerator).toBe('CmdOrCtrl+Q');
    quit.action?.('app:quit');
    expect(action).toHaveBeenCalledWith('app:quit');
    expect(app.items).toContainEqual({ item: 'Hide', text: 'Hide Markwrite' });
    expect(app.items).toContainEqual({ item: 'Services', text: 'Services' });
  });
  it('keeps localized feature menus and changed or disabled accelerators', () => {
    const menu = macMenuOptions(
      [
        {
          label: '文件',
          items: [
            { label: '保存', action: 'app:save' },
            { label: '打开文档…', action: 'app:open' },
          ],
        },
      ],
      { 'app:save': 'Mod+Shift+S', 'app:open': '' },
      'read',
      'github',
      false,
      vi.fn(),
    );
    const file = menu.items![1] as SubmenuOptions;
    expect((file.items![0] as MenuItemOptions).accelerator).toBe('CmdOrCtrl+Shift+S');
    expect((file.items![1] as MenuItemOptions).accelerator).toBeUndefined();
  });
});
it('uses Command and Option on Mac without stealing Control or the system Hide chord', async () => {
  vi.resetModules();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const mac = await import('../src/lib/shortcuts');
  expect(mac.displayShortcut('Mod+Alt+F')).toBe('⌘ ⌥ F');
  expect(
    mac.resolveShortcut(new KeyboardEvent('keydown', { key: 's', metaKey: true }), {}, 'edit')
      .action,
  ).toBe('app:save');
  expect(
    mac.resolveShortcut(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }), {}, 'edit')
      .action,
  ).toBeUndefined();
  expect(
    mac.resolveShortcut(new KeyboardEvent('keydown', { key: 'h', metaKey: true }), {}, 'edit')
      .action,
  ).toBeUndefined();
  expect(
    mac.resolveShortcut(
      new KeyboardEvent('keydown', { key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }),
      {},
      'edit',
    ).action,
  ).toBe('app:replace');
  expect(
    mac.shortcutKey(
      new KeyboardEvent('keydown', { key: '¡', code: 'Digit1', metaKey: true, altKey: true }),
    ),
  ).toBe('Mod+Alt+1');
});
