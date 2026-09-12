import { useState } from 'react';
import { t, useI18n } from '../lib/i18n';
import {
  shortcutBindings,
  shortcutKey,
  shortcutIssues,
  displayShortcut,
  type ShortcutOverrides,
} from '../lib/shortcuts';
export default function ShortcutsPanel({
  value = {},
  onChange,
}: {
  value?: ShortcutOverrides;
  onChange: (value: ShortcutOverrides) => void;
}) {
  const { language } = useI18n();
  const [draft, setDraft] = useState({ ...value });
  const [filter, setFilter] = useState('');
  const issues = shortcutIssues(draft);
  return (
    <div className="shortcut-settings">
      <p>
        {t(
          '点击按键框后按下组合键；Delete 清除，Escape 取消。修改后点击应用。',
          'Focus a key field and press a chord; Delete clears and Escape cancels. Apply to save changes.',
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
            <label key={binding.action}>
              <span>
                {language === 'en' ? binding.en : binding.label}
                {binding.context && (
                  <small>
                    {binding.context === 'read' ? t('阅读', 'Read') : t('编辑', 'Edit')}
                  </small>
                )}
              </span>
              <input
                readOnly
                aria-label={language === 'en' ? binding.en : binding.label}
                value={displayShortcut(draft[binding.action] ?? binding.key)}
                placeholder={t('未设置', 'Unassigned')}
                onKeyDown={(event) => {
                  if (event.key === 'Tab') return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setDraft((d) => ({
                      ...d,
                      [binding.action]: value[binding.action] ?? binding.key,
                    }));
                    return;
                  }
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    setDraft((d) => ({ ...d, [binding.action]: '' }));
                    return;
                  }
                  const key = shortcutKey(event.nativeEvent);
                  if (key) setDraft((d) => ({ ...d, [binding.action]: key }));
                }}
              />
            </label>
          ))}
      </div>
      {issues.length > 0 && <p role="alert">{issues.join('\n')}</p>}
      <div className="shortcut-settings-actions">
        <button onClick={() => setDraft({})}>{t('恢复默认', 'Restore defaults')}</button>
        <button disabled={issues.length > 0} onClick={() => onChange(draft)}>
          {t('应用快捷键', 'Apply shortcuts')}
        </button>
      </div>
    </div>
  );
}
