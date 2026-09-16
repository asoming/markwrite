import { useEffect, useState } from 'react';
import { t, useI18n } from '../lib/i18n';
import {
  shortcutBindings,
  shortcutKey,
  shortcutIssues,
  displayShortcut,
  type ShortcutOverrides,
} from '../lib/shortcuts';
const emptyShortcuts: ShortcutOverrides = {};
export default function ShortcutsPanel({
  value = emptyShortcuts,
  onChange,
}: {
  value?: ShortcutOverrides;
  onChange: (value: ShortcutOverrides) => void;
}) {
  const { language } = useI18n();
  const [draft, setDraft] = useState({ ...value });
  const [recording, setRecording] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft({ ...value });
  }, [value]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('markwrite-shortcut-recording', { detail: true }));
    return () => {
      window.dispatchEvent(new CustomEvent('markwrite-shortcut-recording', { detail: false }));
    };
  }, []);
  const [filter, setFilter] = useState('');
  const issues = shortcutIssues(draft);
  return (
    <div className="shortcut-settings">
      <p>
        {t(
          '点击操作右侧的按钮，按下新组合键，再点击「应用快捷键」。Delete 清除，Escape 取消。',
          'Click a shortcut button, press the new chord, then Apply shortcuts. Delete clears; Escape cancels.',
        )}
      </p>
      <input
        aria-label={t('搜索快捷键', 'Search shortcuts')}
        placeholder={t('搜索操作…', 'Search actions…')}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="shortcut-settings-list">
        {shortcutBindings
          .filter((binding) =>
            `${binding.label} ${binding.en}`.toLowerCase().includes(filter.toLowerCase()),
          )
          .map((binding) => (
            <div className="shortcut-setting-row" key={binding.action}>
              <span>
                {language === 'en' ? binding.en : binding.label}
                {binding.context && (
                  <small>
                    {binding.context === 'read' ? t('阅读', 'Read') : t('编辑', 'Edit')}
                  </small>
                )}
              </span>
              <button
                type="button"
                className="shortcut-capture"
                aria-pressed={recording === binding.action}
                onClick={() => {
                  setRecording(binding.action);
                  setSaved(false);
                }}
                onFocus={() => setRecording(binding.action)}
                onBlur={() => setRecording(null)}
                aria-label={language === 'en' ? binding.en : binding.label}
                onKeyDown={(event) => {
                  if (event.key === 'Tab' || event.nativeEvent.isComposing) return;
                  setSaved(false);
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setDraft((d) => ({
                      ...d,
                      [binding.action]: value[binding.action] ?? binding.key,
                    }));
                    setRecording(null);
                    return;
                  }
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    setDraft((d) => ({ ...d, [binding.action]: '' }));
                    return;
                  }
                  const key = shortcutKey(event.nativeEvent);
                  if (key) {
                    setDraft((d) => ({ ...d, [binding.action]: key }));
                    setRecording(null);
                  }
                }}
              >
                {recording === binding.action
                  ? t('请按组合键…', 'Press shortcut…')
                  : displayShortcut(draft[binding.action] ?? binding.key) ||
                    t('未设置', 'Unassigned')}
              </button>
            </div>
          ))}
      </div>
      {issues.length > 0 && <p role="alert">{issues.join('\n')}</p>}
      {saved && <p role="status">{t('快捷键已保存并生效', 'Shortcuts saved and active')}</p>}
      <div className="shortcut-settings-actions">
        <button
          onClick={() => {
            setDraft({});
            setSaved(false);
          }}
        >
          {t('恢复默认', 'Restore defaults')}
        </button>
        <button
          disabled={issues.length > 0}
          onClick={() => {
            onChange(draft);
            setSaved(true);
          }}
        >
          {t('应用快捷键', 'Apply shortcuts')}
        </button>
      </div>
    </div>
  );
}
