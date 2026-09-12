import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Eye, FileUp, Trash2, Pencil, Download } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { desktop, download } from '../lib/platform';
import type { Language } from '../lib/types';
import {
  compileDocumentTheme,
  createImportedTheme,
  emptyThemeLibrary,
  loadThemeLibrary,
  maxThemeBytes,
  resetThemeLibrary,
  saveThemeLibrary,
  themeLibraryEvent,
  themeLibraryKey,
  ThemeImportError,
  type ImportedTheme,
  type ThemeErrorCode,
  type ThemeLibrary,
  type ThemeNotice,
} from '../lib/themeImport';
import './themeManager.css';
import { readThemePackage, compileThemePackage, type ThemePackage } from '../lib/themePackage';

function initialLibrary() {
  try {
    return { library: loadThemeLibrary(), error: '' };
  } catch {
    return { library: emptyThemeLibrary(), error: 'library' };
  }
}
function useThemeLibrary() {
  const [state, setState] = useState(initialLibrary);
  useEffect(() => {
    const update = () => setState(initialLibrary());
    const storage = (event: StorageEvent) => {
      if (event.key === themeLibraryKey || event.key === null) update();
    };
    window.addEventListener(themeLibraryEvent, update);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(themeLibraryEvent, update);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return state;
}

/** Mount once in App and mark only document-surface containers with
 * data-custom-document-theme. Settings previews use their own scope. */
export function DocumentThemeStyles() {
  const { library } = useThemeLibrary();
  const active = library.themes.find((theme) => theme.id === library.activeId);
  const compiled = useMemo(
    () => (active ? compileDocumentTheme(active.css, active.id) : null),
    [active],
  );
  return compiled ? <style data-imported-document-theme={active!.id}>{compiled.css}</style> : null;
}

const errors: Record<ThemeErrorCode | 'storage' | 'read', [string, string]> = {
  size: ['CSS 与内嵌资源合计最多 1MB。', 'CSS and embedded resources must total no more than 1MB.'],
  syntax: [
    'CSS 语法有误，请检查括号、引号及声明后重新导入。',
    'The CSS could not be parsed. Check braces, quotes, and declarations, then import again.',
  ],
  empty: [
    '没有找到可用于正文的样式。主题需要包含字体、颜色或排版规则。',
    'No supported document styles were found. Include font, color, or typography rules.',
  ],
  name: ['主题名称应为 1–80 个字符。', 'Theme names must contain 1–80 characters.'],
  library: [
    '无法读取已保存的主题。可以清空导入主题后重新导入，文档和内置主题不受影响。',
    'Saved themes could not be read. Clear imported themes and import them again; documents and built-in themes are preserved.',
  ],
  limit: [
    '最多保存 20 个主题，总容量不超过 3MB。请先删除不再使用的主题。',
    'You can save up to 20 themes with a total size of 3MB. Delete an unused theme first.',
  ],
  storage: [
    '主题未保存：本地存储空间不足或不可用。当前设置未更改。',
    'The theme was not saved because local storage is full or unavailable. Current settings were preserved.',
  ],
  read: [
    '无法读取 CSS 文件，请重新选择。',
    'The CSS file could not be read. Please select it again.',
  ],
};
const notices: Record<ThemeNotice, [string, string]> = {
  resources: [
    '部分图片或字体资源已忽略：只保留内嵌的图片、字体及系统字体；相对路径和网络地址不会加载。',
    'Some images or fonts were ignored. Embedded images, embedded fonts, and system fonts are supported; relative paths and network URLs do not load.',
  ],
  'at-rules': [
    '已忽略 @import、动画及其他不支持的 @ 规则。',
    'Imports, animations, and unsupported at-rules were ignored.',
  ],
  properties: [
    '已忽略定位、交互或其他超出正文排版范围的属性。',
    'Positioning, interaction, and other properties outside document typography were ignored.',
  ],
  selectors: [
    '部分选择器不适用于正文，已忽略。',
    'Some selectors cannot be applied to the document and were ignored.',
  ],
};

export default function ThemeManager({ language }: { language: Language }) {
  const { library, error: libraryError } = useThemeLibrary();
  const [candidate, setCandidate] = useState<ImportedTheme>();
  const [previewId, setPreviewId] = useState<string>();
  const [name, setName] = useState('');
  const [error, setError] = useState<keyof typeof errors | ''>('');
  const [message, setMessage] = useState('');
  const [reading, setReading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<ThemePackage>();
  const [entry, setEntry] = useState('');
  const [packageError, setPackageError] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const readGeneration = useRef(0);
  const instanceId = useId()
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
  const t = (zh: string, en: string) => (language === 'en' ? en : zh);
  const localized = (pair: [string, string]) => t(...pair);
  const preview = candidate || library.themes.find((theme) => theme.id === previewId);
  const previewToken = preview ? `preview-${instanceId}-${preview.id}`.slice(0, 80) : '';
  const compiled = useMemo(
    () => (preview ? compileDocumentTheme(preview.css, previewToken, true) : null),
    [preview, previewToken],
  );
  useEffect(
    () => () => {
      readGeneration.current++;
    },
    [],
  );
  function report(reason: unknown) {
    setError(reason instanceof ThemeImportError ? reason.code : 'storage');
    setMessage('');
  }
  function save(next: ThemeLibrary, messageKey: string) {
    try {
      saveThemeLibrary(next);
      setError('');
      setMessage(messageKey);
      return true;
    } catch (reason) {
      report(reason);
      return false;
    }
  }
  async function importPackage(input: File | File[]) {
    const generation = ++readGeneration.current;
    setReading(true);
    setError('');
    setPackageError('');
    setCandidate(undefined);
    setBundle(undefined);
    try {
      const next = await readThemePackage(input);
      if (generation !== readGeneration.current) return;
      setBundle(next);
      setEntry(next.styles[0]);
    } catch (reason) {
      if (generation === readGeneration.current) setPackageError(String(reason));
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  }
  async function previewPackage() {
    if (!bundle) return;
    const generation = ++readGeneration.current;
    setReading(true);
    setError('');
    setPackageError('');
    try {
      const css = await compileThemePackage(bundle, entry);
      if (generation !== readGeneration.current) return;
      const imported = createImportedTheme(
        entry
          .split('/')
          .pop()!
          .replace(/\.css$/i, '')
          .slice(0, 80),
        css,
      );
      setCandidate(imported);
      setName(imported.name);
      setPreviewId(undefined);
    } catch (reason) {
      if (generation === readGeneration.current) {
        if (reason instanceof ThemeImportError) setError(reason.code);
        else setPackageError(String(reason));
      }
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  }
  async function importFile(file: File) {
    if (/\.zip$/i.test(file.name)) {
      await importPackage(file);
      return;
    }
    setBundle(undefined);
    setPackageError('');
    const generation = ++readGeneration.current;
    setReading(true);
    setError('');
    setMessage('');
    setCandidate(undefined);
    setPreviewId(undefined);
    try {
      if (file.size > maxThemeBytes) throw new ThemeImportError('size');
      const css = await file.text();
      if (generation !== readGeneration.current) return;
      const themeName = file.name.replace(/\.css$/i, '').trim() || 'Custom theme';
      const imported = createImportedTheme(themeName.slice(0, 80), css);
      setCandidate(imported);
      setName(imported.name);
    } catch (reason) {
      if (generation === readGeneration.current)
        setError(reason instanceof ThemeImportError ? reason.code : 'read');
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  }
  function install() {
    if (!candidate) return;
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) {
      setError('name');
      return;
    }
    const theme = { ...candidate, name: cleanName };
    if (save({ ...library, themes: [...library.themes, theme], activeId: theme.id }, 'applied')) {
      setCandidate(undefined);
      setPreviewId(theme.id);
    }
  }
  const displayedError = error || (libraryError as keyof typeof errors);
  return (
    <section className="preferences-section theme-manager">
      <div className="theme-manager-heading">
        <h4>{t('导入文档主题', 'Imported document themes')}</h4>
        <button
          type="button"
          className="preference-button"
          onClick={() => fileInput.current?.click()}
          disabled={reading}
        >
          <FileUp size={14} />{' '}
          {reading ? t('读取中…', 'Reading…') : t('导入 CSS / ZIP', 'Import CSS / ZIP')}
        </button>
        <input
          ref={fileInput}
          className="theme-file-input"
          type="file"
          accept=".css,.zip,text/css,application/zip"
          aria-label={t('选择主题 CSS 文件', 'Choose theme CSS file')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <button
          type="button"
          className="preference-button"
          disabled={reading}
          onClick={() => folderInput.current?.click()}
        >
          {t('选择主题文件夹', 'Choose theme folder')}
        </button>
        <input
          ref={folderInput}
          className="theme-file-input"
          type="file"
          multiple
          {...{ webkitdirectory: '' }}
          aria-label={t('主题资源文件夹', 'Theme resource folder')}
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length) void importPackage(files);
          }}
        />
      </div>
      {bundle && (
        <div className="theme-package-picker">
          <label>
            {t('主题样式', 'Theme stylesheet')}{' '}
            <select
              value={entry}
              disabled={reading}
              onChange={(event) => {
                setEntry(event.target.value);
                setCandidate(undefined);
              }}
            >
              {bundle.styles.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="preference-button"
            disabled={reading}
            onClick={() => void previewPackage()}
          >
            {t('加载资源并预览', 'Load resources and preview')}
          </button>
        </div>
      )}
      {packageError && (
        <p role="alert" className="theme-manager-error">
          {t('资源包读取失败：', 'Could not read theme package: ')}
          {packageError}
        </p>
      )}
      <p className="preference-help">
        {t(
          '支持 Typora 的 #write、body 及常见正文样式。先预览再应用；主题只作用于阅读与即时编辑正文，源码、菜单和侧栏保持原样。',
          'Supports Typora #write, body, and common document styles. Preview before applying. Themes affect reading and live editing only; source mode, menus, and sidebars retain their normal appearance.',
        )}
      </p>
      <p className="preference-help">
        {t(
          '编辑器结构与 Typora 不同，复杂插件选择器、动画和定位样式不完全兼容。ZIP 或文件夹可加载其中的 CSS 引用、本地字体和 PNG/JPEG/GIF/WebP/AVIF 图片；不请求网络资源。资源包最多 20MiB，嵌入后的单个主题最多 1MB。',
          'The editor structure differs from Typora, so complex plugin selectors, animations, and positioning are not fully compatible. ZIP/folder imports resolve bundled CSS, fonts and PNG/JPEG/GIF/WebP/AVIF images without network requests. Packages are limited to 20MiB; each embedded theme is limited to 1MB.',
        )}
      </p>
      {displayedError && (
        <p role="alert" className="theme-manager-error">
          {localized(errors[displayedError] || errors.library)}
        </p>
      )}
      {message && (
        <p role="status" className="theme-manager-status">
          {message === 'applied'
            ? t('主题已应用到正文。', 'Theme applied to the document.')
            : message === 'disabled'
              ? t('已恢复内置主题的正文样式。', 'Built-in document styling restored.')
              : message === 'renamed'
                ? t('主题已重命名。', 'Theme renamed.')
                : message === 'deleted'
                  ? t('主题已删除。', 'Theme deleted.')
                  : t('已清空导入主题。', 'Imported themes cleared.')}
        </p>
      )}
      <div className="theme-manager-list">
        {library.themes.map((theme) => (
          <div className="theme-manager-item" key={theme.id}>
            {renaming?.id === theme.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const clean = renaming.name.trim();
                  if (!clean) {
                    setError('name');
                    return;
                  }
                  if (
                    save(
                      {
                        ...library,
                        themes: library.themes.map((item) =>
                          item.id === theme.id ? { ...item, name: clean } : item,
                        ),
                      },
                      'renamed',
                    )
                  )
                    setRenaming(undefined);
                }}
              >
                <input
                  aria-label={t('新主题名称', 'New theme name')}
                  maxLength={80}
                  autoFocus
                  value={renaming.name}
                  onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                />
                <button type="submit">{t('保存', 'Save')}</button>
                <button type="button" onClick={() => setRenaming(undefined)}>
                  {t('取消', 'Cancel')}
                </button>
              </form>
            ) : (
              <span title={theme.name}>{theme.name}</span>
            )}
            <button
              type="button"
              aria-label={`${t('重命名主题', 'Rename theme')} ${theme.name}`}
              onClick={() => setRenaming({ id: theme.id, name: theme.name })}
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              aria-label={`${t('导出主题', 'Export theme')} ${theme.name}`}
              onClick={() => {
                const name = theme.name.replace(/[\\/:*?"<>|]/g, '-') + '.css';
                if (desktop)
                  void invoke('save_export', {
                    name,
                    extension: 'css',
                    bytes: Array.from(new TextEncoder().encode(theme.css)),
                  }).catch(report);
                else download(theme.css, name, 'text/css');
              }}
            >
              <Download size={15} />
            </button>
            {library.activeId === theme.id && (
              <small>
                <Check size={12} /> {t('使用中', 'Active')}
              </small>
            )}
            <button
              type="button"
              title={t('预览', 'Preview')}
              aria-label={`${t('预览主题', 'Preview theme')} ${theme.name}`}
              onClick={() => {
                setCandidate(undefined);
                setPreviewId(theme.id);
                setError('');
              }}
            >
              <Eye size={15} />
            </button>
            <button
              type="button"
              disabled={library.activeId === theme.id}
              aria-label={`${t('应用主题', 'Apply theme')} ${theme.name}`}
              onClick={() => save({ ...library, activeId: theme.id }, 'applied')}
            >
              {t('应用', 'Apply')}
            </button>
            <button
              type="button"
              title={t('删除', 'Delete')}
              aria-label={`${t('删除主题', 'Delete theme')} ${theme.name}`}
              onClick={() => {
                if (
                  save(
                    {
                      ...library,
                      themes: library.themes.filter((item) => item.id !== theme.id),
                      activeId: library.activeId === theme.id ? null : library.activeId,
                    },
                    'deleted',
                  )
                )
                  setPreviewId((id) => (id === theme.id ? undefined : id));
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      {!library.themes.length && !candidate && !libraryError && (
        <p className="preference-help">{t('还没有导入主题。', 'No imported themes yet.')}</p>
      )}
      {preview && compiled && (
        <div className="theme-manager-preview">
          <div className="theme-preview-heading">
            <strong>
              {t('预览', 'Preview')} · {candidate ? name || candidate.name : preview.name}
            </strong>
            <button
              type="button"
              onClick={() => {
                setCandidate(undefined);
                setPreviewId(undefined);
                setError('');
              }}
            >
              {t('取消预览', 'Close preview')}
            </button>
          </div>
          {candidate && (
            <label className="preference-field theme-name-field">
              <span>{t('主题名称', 'Theme name')}</span>
              <input
                aria-label={t('主题名称', 'Theme name')}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {compiled.notices.length > 0 && (
            <ul className="theme-import-notices">
              {compiled.notices.map((notice) => (
                <li key={notice}>{localized(notices[notice])}</li>
              ))}
            </ul>
          )}
          <div className="theme-preview-frame" data-theme-preview={previewToken}>
            <style>{compiled.css}</style>
            <article className="theme-preview-document">
              <h1>{t('让文字自然成形', 'Room for your words')}</h1>
              <p>
                {t(
                  '这是主题预览。中英文可以一起阅读，',
                  'This is a theme preview. Read Chinese and English together, ',
                )}
                <strong>{t('重点清晰', 'with clear emphasis')}</strong>
                {t('，排版舒适。', ' and comfortable typography.')}
              </p>
              <h2>{t('细节与结构', 'Details and structure')}</h2>
              <blockquote>
                {t('一个想法，值得写下来。', 'A thought worth writing down.')}
              </blockquote>
              <ul>
                <li>{t('列表保持整齐', 'Lists stay organized')}</li>
                <li>
                  <code>const idea = "hello";</code>
                </li>
              </ul>
              <pre>
                <code>{'function write() {\n  return "你好 · Hello";\n}'}</code>
              </pre>
              <table>
                <thead>
                  <tr>
                    <th>{t('章节', 'Section')}</th>
                    <th>{t('状态', 'Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t('开始', 'Beginning')}</td>
                    <td>{t('已就绪', 'Ready')}</td>
                  </tr>
                </tbody>
              </table>
            </article>
          </div>
          {candidate && (
            <button
              type="button"
              className="preference-button theme-install"
              onClick={install}
              disabled={!!libraryError}
            >
              {t('保存并应用主题', 'Save and apply theme')}
            </button>
          )}
        </div>
      )}
      {(library.themes.length > 0 || libraryError) && (
        <div className="theme-manager-actions">
          <button
            type="button"
            className="preference-button"
            disabled={!library.activeId}
            onClick={() => save({ ...library, activeId: null }, 'disabled')}
          >
            {t('停用导入主题', 'Disable imported theme')}
          </button>
          {confirmReset ? (
            <>
              <span>{t('删除全部导入主题？', 'Delete all imported themes?')}</span>
              <button
                type="button"
                className="preference-button"
                onClick={() => {
                  try {
                    resetThemeLibrary();
                    setCandidate(undefined);
                    setPreviewId(undefined);
                    setConfirmReset(false);
                    setError('');
                    setMessage('reset');
                  } catch (reason) {
                    report(reason);
                  }
                }}
              >
                {t('确认清空', 'Confirm clear')}
              </button>
              <button type="button" onClick={() => setConfirmReset(false)}>
                {t('取消', 'Cancel')}
              </button>
            </>
          ) : (
            <button type="button" className="theme-clear" onClick={() => setConfirmReset(true)}>
              {t('清空导入主题', 'Clear imported themes')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
