import { afterEach, expect, it } from 'vitest';
import {
  captureBackupSettings,
  restoreBackupSettings,
  validateBackupSettings,
} from '../src/lib/settingsBackup';
import { defaultSettings } from '../src/lib/recovery';
import { createImportedTheme, saveThemeLibrary, loadThemeLibrary } from '../src/lib/themeImport';
afterEach(() => localStorage.clear());
it('restores validated preferences and document themes without carrying unknown fields', () => {
  const theme = createImportedTheme('Example', 'h1 {color: #123456}');
  saveThemeLibrary({ version: 1, themes: [theme], activeId: theme.id });
  const bundle = captureBackupSettings({ ...defaultSettings, language: 'en', width: 820 });
  localStorage.clear();
  expect(restoreBackupSettings(bundle)).toMatchObject({ language: 'en', width: 820 });
  expect(loadThemeLibrary().activeId).toBe(theme.id);
  expect(
    validateBackupSettings({
      token: 'secret',
      fontSize: 1000,
      lineHeight: NaN,
      width: -5,
      language: 'xx',
      customColors: { paper: 'red' },
    }),
  ).toMatchObject({
    fontSize: 32,
    lineHeight: defaultSettings.lineHeight,
    width: 520,
    language: 'zh-CN',
  });
  expect(validateBackupSettings({ token: 'secret' })).not.toHaveProperty('token');
});
it('rejects an invalid bundle before modifying any installed library', () => {
  const original = captureBackupSettings(defaultSettings);
  expect(() =>
    restoreBackupSettings({
      ...original,
      extensions: [{ version: 1, name: 'bad', script: 'alert(1)' }],
    }),
  ).toThrow();
  expect(captureBackupSettings(defaultSettings)).toEqual(original);
  expect(() => restoreBackupSettings({ ...original, version: 2 })).toThrow();
});
