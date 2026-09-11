import { defaultSettings } from './recovery';
import { isTheme } from './themes';
import { loadThemeLibrary, saveThemeLibrary, validateLibrary } from './themeImport';
import { loadExtensions, parseExtension, saveExtensions } from './extensions';
import type { Settings } from './types';
export function captureBackupSettings(settings: Settings) {
  return { version: 1, settings, themes: loadThemeLibrary(), extensions: loadExtensions() };
}
export function validateBackupSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('备份设置无效 / Invalid backup settings');
  const v = value as Record<string, unknown>;
  const settings = { ...defaultSettings };
  if (isTheme(v.theme)) settings.theme = v.theme;
  settings.language = v.language === 'en' ? 'en' : 'zh-CN';
  if (v.defaultMode === 'read' || v.defaultMode === 'live' || v.defaultMode === 'source')
    settings.defaultMode = v.defaultMode;
  for (const field of ['autosave', 'serif', 'followFileParent'] as const)
    if (typeof v[field] === 'boolean') settings[field] = v[field];
  for (const [field, min, max] of [
    ['fontSize', 12, 32],
    ['lineHeight', 1.2, 2.5],
    ['width', 520, 1200],
    ['floatingToolbarTransparency', 0, 80],
  ] as const) {
    const n = v[field];
    if (typeof n === 'number' && Number.isFinite(n))
      settings[field] = Math.max(min, Math.min(max, n));
  }
  for (const field of ['bodyFont', 'codeFont'] as const)
    if (typeof v[field] === 'string' && v[field].length <= 300) settings[field] = v[field];
  settings.attachmentMode = v.attachmentMode === 'embedded' ? 'embedded' : 'relative';
  if (v.customColors && typeof v.customColors === 'object') {
    const colors = v.customColors as Record<string, unknown>;
    if (
      ['paper', 'ink', 'accent'].every(
        (k) => typeof colors[k] === 'string' && /^#[\da-f]{6}$/i.test(colors[k] as string),
      )
    )
      settings.customColors = {
        paper: colors.paper as string,
        ink: colors.ink as string,
        accent: colors.accent as string,
      };
  }
  return settings;
}
export function restoreBackupSettings(bundle: unknown): Settings {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle))
    throw new Error('备份设置包无效 / Invalid settings bundle');
  const b = bundle as Record<string, unknown>;
  if (b.version !== 1)
    throw new Error('不支持这个设置备份版本 / Unsupported settings backup version');
  const settings = validateBackupSettings(b.settings);
  const themes = validateLibrary(b.themes);
  if (!Array.isArray(b.extensions) || b.extensions.length > 32)
    throw new Error('扩展备份无效 / Invalid extension backup');
  const extensions = b.extensions.map((p) => parseExtension(JSON.stringify(p)));
  const previousThemes = loadThemeLibrary(),
    previousExtensions = loadExtensions();
  try {
    saveExtensions(extensions);
    saveThemeLibrary(themes);
  } catch (error) {
    saveExtensions(previousExtensions);
    saveThemeLibrary(previousThemes);
    throw error;
  }
  return settings;
}
