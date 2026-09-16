import { isMac, platformText } from './os';
import type { EditingAction } from '../components/EditingMenu';
export type ShortcutOverrides = Record<string, string>;
type Binding = {
  action: EditingAction;
  label: string;
  en: string;
  key: string;
  context?: 'read' | 'edit';
};
export const shortcutBindings: Binding[] = [
  { action: 'app:new', label: '新建文档', en: 'New document', key: 'Mod+N' },
  { action: 'app:newWindow', label: '新建独立窗口', en: 'New window', key: 'Mod+Shift+N' },
  { action: 'app:open', label: '打开文档', en: 'Open document', key: 'Mod+O' },
  { action: 'app:save', label: '保存', en: 'Save', key: 'Mod+S' },
  { action: 'app:saveAs', label: '另存为', en: 'Save as', key: 'Mod+Shift+S' },
  { action: 'app:quit', label: '退出应用', en: 'Quit application', key: 'Mod+Q' },
  { action: 'app:close', label: '关闭文档', en: 'Close document', key: 'Mod+W' },
  { action: 'app:quickOpen', label: '快速打开', en: 'Quick open', key: 'Mod+P' },
  { action: 'app:commands', label: '命令面板', en: 'Command palette', key: 'Mod+K' },
  { action: 'app:find', label: '查找', en: 'Find', key: 'Mod+F' },
  { action: 'app:replace', label: '替换', en: 'Replace', key: isMac ? 'Mod+Alt+F' : 'Mod+H' },
  { action: 'app:search', label: '文件夹搜索', en: 'Folder search', key: 'Mod+Shift+F' },
  { action: 'app:settings', label: '设置', en: 'Settings', key: 'Mod+,' },
  { action: 'view:live', label: '编辑模式', en: 'Editing mode', key: 'Mod+1' },
  { action: 'view:source', label: '源码模式', en: 'Source mode', key: 'Mod+2' },
  { action: 'view:read', label: '阅读模式', en: 'Reading mode', key: 'Mod+3' },
  { action: 'view:cycle', label: '循环切换模式', en: 'Cycle modes', key: 'Mod+Shift+M' },
  { action: 'view:sidebar', label: '显示或隐藏侧栏', en: 'Toggle sidebar', key: 'Mod+\\' },
  { action: 'view:focus', label: '专注模式', en: 'Focus mode', key: 'F8' },
  {
    action: 'view:split',
    label: '源码 + 阅读（同一文档）',
    en: 'Source + reading (same document)',
    key: '',
  },
  { action: 'view:compare', label: '并排对照', en: 'Side by side', key: '' },
  { action: 'app:undo', label: '撤销', en: 'Undo', key: 'Mod+Z', context: 'edit' },
  { action: 'app:redo', label: '重做', en: 'Redo', key: 'Mod+Shift+Z', context: 'edit' },
  { action: 'app:selectAll', label: '全选', en: 'Select all', key: 'Mod+A' },
  { action: 'format:bold', label: '粗体', en: 'Bold', key: 'Mod+B', context: 'edit' },
  { action: 'format:italic', label: '斜体', en: 'Italic', key: 'Mod+I', context: 'edit' },
  {
    action: 'format:strike',
    label: '删除线',
    en: 'Strikethrough',
    key: 'Mod+Shift+X',
    context: 'edit',
  },
  {
    action: 'format:inlineCode',
    label: '行内代码',
    en: 'Inline code',
    key: 'Mod+E',
    context: 'edit',
  },
  ...[1, 2, 3].map((n): Binding => ({
    action: `format:heading${n}` as EditingAction,
    label: `${n}级标题`,
    en: `Heading ${n}`,
    key: `Mod+Alt+${n}`,
    context: 'edit',
  })),
  {
    action: 'format:moveUp',
    label: '段落上移',
    en: 'Move paragraph up',
    key: 'Alt+ArrowUp',
    context: 'edit',
  },
  {
    action: 'format:moveDown',
    label: '段落下移',
    en: 'Move paragraph down',
    key: 'Alt+ArrowDown',
    context: 'edit',
  },
  {
    action: 'view:back',
    label: '阅读后退',
    en: 'Reading back',
    key: 'Alt+ArrowLeft',
    context: 'read',
  },
  {
    action: 'view:forward',
    label: '阅读前进',
    en: 'Reading forward',
    key: 'Alt+ArrowRight',
    context: 'read',
  },
  {
    action: 'view:previousFile',
    label: '上一篇',
    en: 'Previous file',
    key: 'Alt+ArrowUp',
    context: 'read',
  },
  {
    action: 'view:nextFile',
    label: '下一篇',
    en: 'Next file',
    key: 'Alt+ArrowDown',
    context: 'read',
  },
  { action: 'view:bookmark', label: '段落书签', en: 'Bookmark', key: 'Mod+D', context: 'read' },
];
const shiftedKeys: Record<string, string> = {
  '~': '`',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '<': ',',
  '>': '.',
  '?': '/',
};
export function shortcutKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
    code?: string;
  },
): string {
  if (['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(event.key))
    return '';
  return [
    isMac
      ? event.metaKey
        ? 'Mod'
        : event.ctrlKey
          ? 'Ctrl'
          : ''
      : event.ctrlKey || event.metaKey
        ? 'Mod'
        : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    (event.shiftKey || (isMac && event.altKey)) && /^Digit[0-9]$/.test(event.code || '')
      ? event.code!.slice(-1)
      : isMac && event.altKey && /^Key[A-Z]$/.test(event.code || '')
        ? event.code!.slice(-1)
        : event.shiftKey && shiftedKeys[event.key]
          ? shiftedKeys[event.key]
          : event.key.length === 1
            ? event.key.toUpperCase()
            : event.key,
  ]
    .filter(Boolean)
    .join('+');
}
const keyPattern =
  /^(?:(?:(?:Mod|Ctrl)\+)(?:Alt\+)?(?:Shift\+)?|Alt\+(?:Shift\+)?|Shift\+(?=F\d)|(?=F\d))(?:[A-Z0-9,.;/\\\[\]`=-]|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))$/;
export function shortcutIssues(overrides: ShortcutOverrides): string[] {
  const issues: string[] = [];
  for (const [action, key] of Object.entries(overrides)) {
    if (
      !shortcutBindings.some((binding) => binding.action === action) ||
      (key !== '' && !keyPattern.test(key))
    )
      issues.push(`快捷键无效 / Invalid shortcut: ${action}`);
  }
  for (const [i, binding] of shortcutBindings.entries()) {
    const key = overrides[binding.action] ?? binding.key;
    if (!key) continue;
    const other = shortcutBindings
      .slice(i + 1)
      .find(
        (entry) =>
          (overrides[entry.action] ?? entry.key) === key &&
          (!entry.context || !binding.context || entry.context === binding.context),
      );
    if (other)
      issues.push(`${binding.label} / ${binding.en} ↔ ${other.label} / ${other.en}: ${key}`);
  }
  return issues;
}
export function validShortcuts(value: unknown): ShortcutOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (Object.values(value).some((v) => typeof v !== 'string')) return {};
  const result = value as ShortcutOverrides;
  const retained: ShortcutOverrides = {};
  for (const [action, key] of Object.entries(result)) {
    if (
      shortcutBindings.some((binding) => binding.action === action) &&
      (!key || keyPattern.test(key))
    )
      retained[action] = key;
  }
  // New default bindings must never invalidate an existing custom configuration.
  for (const binding of shortcutBindings) {
    if (binding.action in retained || !binding.key) continue;
    if (
      shortcutBindings.some(
        (other) =>
          other.action in retained &&
          retained[other.action] === binding.key &&
          (!other.context || !binding.context || other.context === binding.context),
      )
    )
      retained[binding.action] = '';
  }
  return shortcutIssues(retained).length ? {} : retained;
}
export function resolveShortcut(
  event: KeyboardEvent,
  overrides: ShortcutOverrides = {},
  mode: 'read' | 'edit',
) {
  const key = shortcutKey(event);
  const eligible = shortcutBindings.filter((item) => !item.context || item.context === mode);
  const action = eligible.find(
    (item) => (overrides[item.action] ?? item.key) === key && key,
  )?.action;
  const blocked =
    !action &&
    eligible.some(
      (item) => item.key === key && item.action in overrides && overrides[item.action] !== item.key,
    );
  return { action, blocked };
}
export function displayShortcut(key: string) {
  return isMac
    ? key
        .replace('Mod', '⌘')
        .replace('Ctrl', '⌃')
        .replace('Alt', '⌥')
        .replace('Shift', '⇧')
        .replaceAll('+', ' ')
    : platformText(key.replace('Mod', 'Ctrl').replaceAll('+', ' '));
}
