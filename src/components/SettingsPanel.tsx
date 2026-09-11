import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Check, FileText, Globe, Image, Palette, Type, X } from 'lucide-react';
import { defaultSettings } from '../lib/recovery';
import { resolveTheme, themeOptions } from '../lib/themes';
import type { Settings } from '../lib/types';
import './settings.css';

export type DefaultAppResult = { status: 'set' | 'settings-opened'; message?: string };
export type SettingsPanelProps = {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  onDefaultApp: () => Promise<DefaultAppResult>;
  onCheckDefaultApp?: () => Promise<boolean | null>;
  defaultAppAvailable?: boolean;
};
type Category = 'files' | 'editor' | 'images' | 'appearance' | 'general';

export default function SettingsPanel({
  settings,
  onChange,
  onClose,
  onDefaultApp,
  onCheckDefaultApp,
  defaultAppAvailable = true,
}: SettingsPanelProps) {
  const [category, setCategory] = useState<Category>('general');
  const [association, setAssociation] = useState<boolean | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [result, setResult] = useState<DefaultAppResult>();
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const check = useRef(onCheckDefaultApp);
  check.current = onCheckDefaultApp;
  const mounted = useRef(true);
  const id = useId();
  const t = (zh: string, en: string) => (settings.language === 'en' ? en : zh);
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const categories = [
    {
      id: 'files' as const,
      icon: FileText,
      name: t('文件', 'Files'),
      detail: t('保存与默认打开方式', 'Saving and file associations'),
    },
    {
      id: 'editor' as const,
      icon: Type,
      name: t('编辑器', 'Editor'),
      detail: t('打开模式与正文排版', 'Opening mode and typography'),
    },
    {
      id: 'images' as const,
      icon: Image,
      name: t('图像', 'Images'),
      detail: t('本地图片的保存位置', 'Where local images are stored'),
    },
    {
      id: 'appearance' as const,
      icon: Palette,
      name: t('外观', 'Appearance'),
      detail: t('主题与自定义颜色', 'Themes and custom colors'),
    },
    {
      id: 'general' as const,
      icon: Globe,
      name: t('通用', 'General'),
      detail: t('界面语言与偏好设置', 'Language and preferences'),
    },
  ];
  const selected = categories.find((item) => item.id === category)!;

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      mounted.current = false;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (category !== 'files' || !check.current) return;
    let disposed = false;
    void check
      .current()
      .then((value) => {
        if (!disposed) setAssociation(value);
      })
      .catch(() => {
        if (!disposed) setAssociation(null);
      });
    return () => {
      disposed = true;
    };
  }, [category]);
  function keyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = panel.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled):not([tabindex="-1"]),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
    );
    if (!elements?.length) return;
    const first = elements[0],
      last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  function navigateCategory(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      next = (index + 1) % categories.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      next = (index + categories.length - 1) % categories.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = categories.length - 1;
    else return;
    event.preventDefault();
    setCategory(categories[next].id);
    panel.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  async function requestDefault() {
    setRequesting(true);
    setError('');
    setResult(undefined);
    try {
      const response = await onDefaultApp();
      if (mounted.current) {
        setResult(response);
        if (response.status === 'set') setAssociation(true);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setRequesting(false);
    }
  }
  const resolvedTheme = resolveTheme(
    settings.theme,
    window.matchMedia?.('(prefers-color-scheme: dark)').matches || false,
  );
  const currentTheme = themeOptions.find((option) => option.id === resolvedTheme)!;
  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        ref={panel}
        onKeyDown={keyDown}
      >
        <aside className="settings-navigation">
          <div className="settings-brand">
            <span>MARKWRITE</span>
            <h2 id={`${id}-title`}>{t('偏好设置', 'Preferences')}</h2>
          </div>
          <div
            role="tablist"
            aria-label={t('设置分类', 'Settings categories')}
            aria-orientation="vertical"
          >
            {categories.map((item, index) => (
              <button
                type="button"
                role="tab"
                key={item.id}
                id={`${id}-tab-${item.id}`}
                aria-controls={`${id}-panel`}
                aria-selected={category === item.id}
                tabIndex={category === item.id ? 0 : -1}
                onClick={() => setCategory(item.id)}
                onKeyDown={(event) => navigateCategory(event, index)}
              >
                <item.icon size={18} aria-hidden="true" />
                <span>{item.name}</span>
              </button>
            ))}
          </div>
          <p className="settings-local-note">{t('设置保存在本机', 'Saved on this device')}</p>
        </aside>
        <div className="settings-content">
          <header className="settings-content-header">
            <div>
              <h3>{selected.name}</h3>
              <p>{selected.detail}</p>
            </div>
            <button
              type="button"
              className="settings-close"
              aria-label={t('关闭设置', 'Close preferences')}
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </header>
          <div
            className="settings-scroll"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-tab-${category}`}
            tabIndex={0}
          >
            {category === 'general' && (
              <>
                <section className="preferences-section">
                  <h4>{t('语言', 'Language')}</h4>
                  <label className="preference-field">
                    <span>{t('界面语言', 'Interface language')}</span>
                    <select
                      aria-label={t('界面语言', 'Interface language')}
                      value={settings.language}
                      onChange={(event) =>
                        update({ language: event.target.value as Settings['language'] })
                      }
                    >
                      <option value="zh-CN">简体中文</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <p className="preference-help">
                    {t(
                      '切换后立即生效，不改变文档内容。',
                      'Changes take effect immediately. Your document content stays the same.',
                    )}
                  </p>
                </section>
                <section className="preferences-section">
                  <h4>{t('恢复偏好', 'Reset preferences')}</h4>
                  <p className="preference-help">
                    {t(
                      '恢复默认主题、排版、语言、打开模式和保存设置。已有文档与系统默认打开方式不受影响。',
                      'Restore the default theme, typography, language, opening mode, and saving preferences. Documents and system file associations are unchanged.',
                    )}
                  </p>
                  <button
                    type="button"
                    className="preference-button"
                    onClick={() => onChange({ ...defaultSettings })}
                  >
                    {t('恢复默认设置', 'Reset preferences')}
                  </button>
                </section>
              </>
            )}
            {category === 'files' && (
              <>
                <section className="preferences-section">
                  <h4>{t('保存', 'Saving')}</h4>
                  <label className="preference-toggle">
                    <span>
                      {t('自动保存', 'Autosave')}
                      <small>
                        {t(
                          '停止输入后，保存已有路径的文档',
                          'Save documents with a file path after typing stops',
                        )}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      className="switch"
                      aria-label={t('自动保存', 'Autosave')}
                      checked={settings.autosave}
                      onChange={(event) => update({ autosave: event.target.checked })}
                    />
                  </label>
                  <p className="preference-help">
                    {t(
                      '新文档先保留为本地草稿。按 Ctrl+S 选择位置后，才会写入 Markdown 文件。',
                      'New documents start as local drafts. Press Ctrl+S to choose where to save a Markdown file.',
                    )}
                  </p>
                </section>
                <section className="preferences-section">
                  <h4>{t('默认打开方式', 'Default application')}</h4>
                  <p className="preference-help">
                    {t(
                      '双击 .md 或 .markdown 文件时，使用墨页打开。Windows 可能需要在系统默认应用中完成选择。',
                      'Open .md and .markdown files with Markwrite when double-clicked. Windows may ask you to finish the selection in system settings.',
                    )}
                  </p>
                  {association === true && (
                    <p className="preference-success">
                      <Check size={15} />
                      {t('墨页已是 Markdown 默认应用', 'Markwrite is the default Markdown app')}
                    </p>
                  )}
                  <button
                    type="button"
                    className="preference-button"
                    disabled={requesting || !defaultAppAvailable}
                    onClick={() => void requestDefault()}
                  >
                    {requesting
                      ? t('正在处理…', 'Working…')
                      : t(
                          '将 Markdown 默认设为墨页打开',
                          'Use Markwrite as the default Markdown app',
                        )}
                  </button>
                  {!defaultAppAvailable && (
                    <p className="preference-help">
                      {t(
                        '请在支持文件关联的桌面版中设置。',
                        'Use a desktop version that supports file associations.',
                      )}
                    </p>
                  )}
                  {result && (
                    <p role="status" className="preference-help">
                      {result.status === 'set'
                        ? t('默认打开方式已更新。', 'The default application was updated.')
                        : t(
                            '已打开系统设置，请选择墨页完成关联。',
                            'System settings are open. Select Markwrite to finish the association.',
                          )}
                      {result.message && (
                        <span className="preference-result-detail">{result.message}</span>
                      )}
                    </p>
                  )}
                  {error && (
                    <p role="alert" className="preference-error">
                      {t('未能更改默认应用：', 'Could not change the default application: ')}
                      {error}
                    </p>
                  )}
                </section>
                <section className="preferences-section">
                  <h4>{t('搜索范围', 'Search scope')}</h4>
                  <p className="preference-help">
                    {t(
                      '仅搜索当前工作文件夹。扫描排除隐藏目录、.git、node_modules、target 和符号链接；最多显示 500 条匹配，可随时取消。',
                      'Search covers the current workspace. Hidden folders, .git, node_modules, target, and symbolic links are excluded. Up to 500 matches are shown; you can cancel a search.',
                    )}
                  </p>
                </section>
              </>
            )}
            {category === 'editor' && (
              <>
                <section className="preferences-section">
                  <h4>{t('打开文档', 'Opening documents')}</h4>
                  <label className="preference-field">
                    <span>{t('默认打开模式', 'Default opening mode')}</span>
                    <select
                      aria-label={t('默认打开模式', 'Default opening mode')}
                      value={settings.defaultMode}
                      onChange={(event) =>
                        update({ defaultMode: event.target.value as Settings['defaultMode'] })
                      }
                    >
                      <option value="read">{t('阅读模式', 'Reading')}</option>
                      <option value="live">{t('即时渲染编辑', 'Live editing')}</option>
                      <option value="source">{t('Markdown 源码', 'Markdown source')}</option>
                    </select>
                  </label>
                  <p className="preference-help">
                    {t(
                      '下次打开文档时使用；当前文档可通过“视图”菜单切换模式。',
                      'Used when opening a document. Change the current document mode from the View menu.',
                    )}
                  </p>
                </section>
                <section className="preferences-section">
                  <h4>{t('正文排版', 'Typography')}</h4>
                  {(
                    [
                      {
                        key: 'fontSize',
                        zh: '字号',
                        en: 'Font size',
                        min: 13,
                        max: 24,
                        step: 1,
                        suffix: 'px',
                      },
                      {
                        key: 'lineHeight',
                        zh: '行高',
                        en: 'Line height',
                        min: 1.4,
                        max: 2.3,
                        step: 0.1,
                        suffix: '',
                      },
                      {
                        key: 'width',
                        zh: '正文宽度',
                        en: 'Content width',
                        min: 560,
                        max: 1100,
                        step: 20,
                        suffix: 'px',
                      },
                    ] as const
                  ).map((field) => (
                    <label className="preference-range" key={field.key}>
                      <span>{t(field.zh, field.en)}</span>
                      <input
                        type="range"
                        aria-label={t(field.zh, field.en)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={settings[field.key]}
                        onChange={(event) => update({ [field.key]: Number(event.target.value) })}
                      />
                      <output>
                        {field.key === 'lineHeight'
                          ? settings[field.key].toFixed(1)
                          : settings[field.key]}
                        {field.suffix}
                      </output>
                    </label>
                  ))}
                  <label className="preference-field">
                    <span>{t('字体风格', 'Font style')}</span>
                    <select
                      aria-label={t('字体风格', 'Font style')}
                      value={settings.serif ? 'serif' : 'sans'}
                      onChange={(event) => update({ serif: event.target.value === 'serif' })}
                    >
                      <option value="sans">{t('清晰黑体', 'Sans serif')}</option>
                      <option value="serif">{t('书卷宋体', 'Serif')}</option>
                    </select>
                  </label>
                  <label className="preference-field preference-stacked">
                    <span>{t('正文字体', 'Body font')}</span>
                    <input
                      aria-label={t('正文字体名称', 'Body font name')}
                      placeholder={t('留空使用默认字体', 'Leave blank to use the default font')}
                      value={settings.bodyFont || ''}
                      onChange={(event) => update({ bodyFont: event.target.value })}
                    />
                  </label>
                  <label className="preference-field preference-stacked">
                    <span>{t('代码字体', 'Code font')}</span>
                    <input
                      aria-label={t('代码字体名称', 'Code font name')}
                      value={settings.codeFont || ''}
                      onChange={(event) => update({ codeFont: event.target.value })}
                    />
                  </label>
                  <p className="preference-help">
                    {t(
                      '填写电脑上已安装的字体名称；未找到时会使用系统备用字体。',
                      'Use a font installed on your computer. Missing fonts fall back to system fonts.',
                    )}
                  </p>
                </section>
                <section className="preferences-section">
                  <h4>{t('阅读排版预设', 'Typography presets')}</h4>
                  <div className="preference-preset-buttons">
                    <button
                      type="button"
                      className="preference-button"
                      onClick={() =>
                        update({ fontSize: 17, lineHeight: 1.9, width: 760, serif: false })
                      }
                    >
                      {t('日常写作', 'Everyday writing')}
                    </button>
                    <button
                      type="button"
                      className="preference-button"
                      onClick={() =>
                        update({ fontSize: 19, lineHeight: 2, width: 720, serif: true })
                      }
                    >
                      {t('长文阅读', 'Long-form reading')}
                    </button>
                    <button
                      type="button"
                      className="preference-button"
                      onClick={() =>
                        update({ fontSize: 15, lineHeight: 1.6, width: 1000, serif: false })
                      }
                    >
                      {t('技术文档', 'Technical documents')}
                    </button>
                  </div>
                </section>
              </>
            )}
            {category === 'images' && (
              <section className="preferences-section">
                <h4>{t('保存图片', 'Saving images')}</h4>
                <label className="preference-field preference-stacked">
                  <span>{t('图片保存方式', 'Image storage')}</span>
                  <select
                    aria-label={t('图片保存方式', 'Image storage')}
                    value={settings.attachmentMode}
                    onChange={(event) =>
                      update({ attachmentMode: event.target.value as Settings['attachmentMode'] })
                    }
                  >
                    <option value="relative">
                      {t('文档旁的 assets 文件夹', 'An assets folder beside the document')}
                    </option>
                    <option value="embedded">{t('内嵌到 Markdown', 'Embed in Markdown')}</option>
                  </select>
                </label>
                <p className="preference-help">
                  {t(
                    'assets 方式使用相对路径，移动文档时请一起移动该文件夹。新草稿的图片会在首次保存时迁移；内嵌方式将图片保存在文档内，文件会更大。',
                    'The assets option uses relative paths: move the folder with your document. Draft images are moved on the first save. Embedding keeps images inside Markdown and makes the file larger.',
                  )}
                </p>
                <p className="preference-help">
                  {t(
                    '此设置控制新增图片，不会自动搬动已存在的附件。网络图片需要明确点击加载。',
                    'This controls new images and does not relocate existing attachments. Remote images load only when you explicitly request them.',
                  )}
                </p>
              </section>
            )}
            {category === 'appearance' && (
              <>
                <section className="preferences-section">
                  <h4>{t('主题', 'Theme')}</h4>
                  <div className="preference-theme-grid">
                    {themeOptions.map((theme) => (
                      <button
                        type="button"
                        key={theme.id}
                        className={`preference-theme ${settings.theme === theme.id ? 'is-selected' : ''}`}
                        aria-pressed={settings.theme === theme.id}
                        aria-label={theme.name[settings.language]}
                        onClick={() =>
                          update({ theme: theme.id, serif: theme.serif, customColors: undefined })
                        }
                        style={
                          {
                            '--preview-paper': theme.paper,
                            '--preview-ink': theme.ink,
                            '--preview-accent': theme.accent,
                          } as CSSProperties
                        }
                      >
                        <span
                          className={`preference-theme-sample ${theme.serif ? 'is-serif' : ''}`}
                          aria-hidden="true"
                        >
                          <strong>{t('写下所想', 'A thought, written')}</strong>
                          <span>{t('让文字慢慢成形。', 'Room for your words.')}</span>
                          <i />
                          <i />
                          <em>Markdown</em>
                        </span>
                        <span className="preference-theme-label">
                          {theme.name[settings.language]}
                          {settings.theme === theme.id && <Check size={15} />}
                        </span>
                        <small>{theme.description[settings.language]}</small>
                      </button>
                    ))}
                  </div>
                  <p className="preference-help">
                    {t(
                      '主题同时用于编辑与阅读。切换主题会恢复其配色和字体风格，保留自定义字体、字号、行高与宽度。',
                      'Themes apply to editing and reading. Selecting a theme restores its palette and font style while keeping custom fonts, size, line height, and width.',
                    )}
                  </p>
                </section>
                <section className="preferences-section">
                  <h4>{t('自定义颜色', 'Custom colors')}</h4>
                  <div className="preference-colors">
                    {(['paper', 'ink', 'accent'] as const).map((key) => (
                      <label className="preference-color" key={key}>
                        <input
                          type="color"
                          aria-label={t(
                            { paper: '背景颜色', ink: '正文颜色', accent: '强调色' }[key],
                            {
                              paper: 'Background color',
                              ink: 'Text color',
                              accent: 'Accent color',
                            }[key],
                          )}
                          value={settings.customColors?.[key] || currentTheme[key]}
                          onChange={(event) =>
                            update({
                              customColors: {
                                paper: currentTheme.paper,
                                ink: currentTheme.ink,
                                accent: currentTheme.accent,
                                ...settings.customColors,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                        <span>
                          {t(
                            { paper: '背景', ink: '正文', accent: '强调色' }[key],
                            { paper: 'Background', ink: 'Text', accent: 'Accent' }[key],
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="preference-button"
                    disabled={!settings.customColors}
                    onClick={() => update({ customColors: undefined })}
                  >
                    {t('恢复主题原色', 'Restore theme colors')}
                  </button>
                </section>
              </>
            )}
          </div>
          <footer className="settings-footer">
            <span>{t('修改即时生效', 'Changes apply immediately')}</span>
            <button type="button" className="settings-done" onClick={onClose}>
              {t('完成', 'Done')}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
