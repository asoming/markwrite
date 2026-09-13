import type { MenuOptions, SubmenuOptions, MenuItemOptions } from '@tauri-apps/api/menu';
import type { EditingAction } from '../components/EditingMenu';
import { shortcutBindings, type ShortcutOverrides } from './shortcuts';
import { t } from './i18n';
import type { Mode, Theme } from './types';
export type MenuSection = {
  label: string;
  items: ('separator' | { label: string; action: EditingAction; shortcut?: string })[];
};
export function macMenuOptions(
  sections: MenuSection[],
  shortcuts: ShortcutOverrides,
  mode: Mode,
  theme: Theme,
  focus: boolean,
  onAction: (action: EditingAction) => void,
): MenuOptions {
  const action = (command: EditingAction) => () => {
    const field = document.activeElement?.matches('input,textarea');
    if (field && ['app:undo', 'app:redo', 'app:selectAll'].includes(command)) {
      document.execCommand(command.slice(4));
    } else onAction(command);
  };
  const item = (command: EditingAction, text: string, key?: string): MenuItemOptions => ({
    id: command,
    text,
    action: action(command),
    accelerator: key ? key.replace('Mod', 'CmdOrCtrl') : undefined,
  });
  const separator = { item: 'Separator' as const };
  const groups: SubmenuOptions[] = sections.map((section) => ({
    text: t(section.label),
    items: section.items.flatMap((entry): NonNullable<SubmenuOptions['items']> => {
      if (entry === 'separator') return [separator];
      if (['app:quit', 'app:about', 'app:settings'].includes(entry.action)) return [];
      const binding = shortcutBindings.find((b) => b.action === entry.action);
      const key = shortcuts[entry.action] ?? binding?.key;
      const option = item(entry.action, t(entry.label), key || undefined);
      const checked = entry.action.startsWith('theme:')
        ? entry.action === `theme:${theme}`
        : ['view:read', 'view:live', 'view:source'].includes(entry.action)
          ? entry.action === `view:${mode}`
          : entry.action === 'view:focus'
            ? focus
            : undefined;
      return [checked === undefined ? option : { ...option, checked }];
    }),
  }));
  const edit = groups.find((_, i) => sections[i].label === '编辑');
  edit?.items?.splice(
    3,
    0,
    { item: 'Cut', text: t('剪切', 'Cut') },
    { item: 'Copy', text: t('复制', 'Copy') },
    { item: 'Paste', text: t('粘贴', 'Paste') },
    separator,
  );
  return {
    items: [
      {
        text: 'Markwrite',
        items: [
          item('app:about', t('关于 Markwrite', 'About Markwrite')),
          separator,
          item('app:settings', t('设置…', 'Settings…'), shortcuts['app:settings'] ?? 'Mod+,'),
          separator,
          { item: 'Services', text: t('服务', 'Services') },
          separator,
          { item: 'Hide', text: t('隐藏 Markwrite', 'Hide Markwrite') },
          { item: 'HideOthers', text: t('隐藏其他', 'Hide Others') },
          { item: 'ShowAll', text: t('显示全部', 'Show All') },
          separator,
          item('app:quit', t('退出 Markwrite', 'Quit Markwrite'), 'Mod+Q'),
        ],
      },
      ...groups,
      {
        text: t('窗口', 'Window'),
        items: [
          { item: 'Minimize', text: t('最小化', 'Minimize') },
          { item: 'Maximize', text: t('缩放', 'Zoom') },
          { item: 'Fullscreen', text: t('进入全屏', 'Enter Full Screen') },
          separator,
          { item: 'BringAllToFront', text: t('全部前置', 'Bring All to Front') },
        ],
      },
    ],
  };
}
// Serialize replacements so a slower previous language/mode cannot overwrite the latest menu.
let queue = Promise.resolve();
export function scheduleMacMenu(task: () => Promise<void>) {
  queue = queue.catch(() => {}).then(task);
  return queue;
}
