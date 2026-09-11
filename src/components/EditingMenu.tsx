import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { FormatAction } from '../editor/formatting';
import type { Mode } from '../lib/types';
import './editing.css';

export type EditingAction =
  | `format:${FormatAction}`
  | 'app:new'
  | 'app:open'
  | 'app:folder'
  | 'app:save'
  | 'app:saveAs'
  | 'app:exportHtml'
  | 'app:exportPdf'
  | 'app:exportDocx'
  | 'app:close'
  | 'app:quit'
  | 'app:upload'
  | 'app:publish'
  | 'app:find'
  | 'app:replace'
  | 'app:selectAll'
  | 'app:undo'
  | 'app:redo'
  | 'app:settings'
  | 'app:shortcuts'
  | 'app:about'
  | 'app:extensions'
  | 'app:ai'
  | 'app:quickOpen'
  | 'app:search'
  | 'insert:link'
  | 'insert:image'
  | 'insert:table'
  | 'insert:math'
  | 'insert:mermaid'
  | 'insert:code'
  | 'view:live'
  | 'view:source'
  | 'view:read'
  | 'view:focus'
  | 'view:sidebar'
  | 'view:compare'
  | 'view:history'
  | 'view:backlinks'
  | 'view:attachments'
  | 'view:workspace'
  | 'view:git'
  | 'theme:light'
  | 'theme:dark'
  | 'theme:system';
type Item = { label: string; action: EditingAction; shortcut?: string } | 'separator';
const menus: { label: string; items: Item[] }[] = [
  {
    label: '文件',
    items: [
      { label: '新建文档', action: 'app:new', shortcut: 'Ctrl N' },
      { label: '打开文档…', action: 'app:open', shortcut: 'Ctrl O' },
      { label: '打开文件夹…', action: 'app:folder' },
      { label: '快速打开…', action: 'app:quickOpen', shortcut: 'Ctrl P' },
      'separator',
      { label: '保存', action: 'app:save', shortcut: 'Ctrl S' },
      { label: '另存为…', action: 'app:saveAs', shortcut: 'Ctrl Shift S' },
      'separator',
      { label: '导出 HTML…', action: 'app:exportHtml' },
      { label: '导出 PDF…', action: 'app:exportPdf' },
      { label: '导出 Word 文档…', action: 'app:exportDocx' },
      'separator',
      { label: '关闭当前文档', action: 'app:close', shortcut: 'Ctrl W' },
      { label: '退出墨页', action: 'app:quit' },
    ],
  },
  {
    label: '编辑',
    items: [
      { label: '撤销', action: 'app:undo', shortcut: 'Ctrl Z' },
      { label: '重做', action: 'app:redo', shortcut: 'Ctrl Shift Z' },
      'separator',
      { label: '全选', action: 'app:selectAll', shortcut: 'Ctrl A' },
      { label: '查找', action: 'app:find', shortcut: 'Ctrl F' },
      { label: '查找与替换', action: 'app:replace', shortcut: 'Ctrl H' },
      { label: '文件夹全文搜索', action: 'app:search', shortcut: 'Ctrl Shift F' },
      'separator',
      { label: '段落上移', action: 'format:moveUp', shortcut: 'Alt ↑' },
      { label: '段落下移', action: 'format:moveDown', shortcut: 'Alt ↓' },
    ],
  },
  {
    label: '段落',
    items: [
      { label: '正文', action: 'format:paragraph' },
      { label: '一级标题', action: 'format:heading1', shortcut: 'Ctrl Alt 1' },
      { label: '二级标题', action: 'format:heading2', shortcut: 'Ctrl Alt 2' },
      { label: '三级标题', action: 'format:heading3', shortcut: 'Ctrl Alt 3' },
      { label: '四级标题', action: 'format:heading4' },
      { label: '五级标题', action: 'format:heading5' },
      { label: '六级标题', action: 'format:heading6' },
      'separator',
      { label: '引用', action: 'format:quote' },
      { label: '无序列表', action: 'format:bulletList' },
      { label: '有序列表', action: 'format:orderedList' },
      { label: '待办列表', action: 'format:taskList' },
      'separator',
      { label: '增加缩进', action: 'format:indent' },
      { label: '减少缩进', action: 'format:outdent' },
    ],
  },
  {
    label: '格式',
    items: [
      { label: '粗体', action: 'format:bold', shortcut: 'Ctrl B' },
      { label: '斜体', action: 'format:italic', shortcut: 'Ctrl I' },
      { label: '删除线', action: 'format:strike', shortcut: 'Ctrl Shift X' },
      { label: '行内代码', action: 'format:inlineCode', shortcut: 'Ctrl E' },
    ],
  },
  {
    label: '插入',
    items: [
      { label: '链接…', action: 'insert:link' },
      { label: '图片…', action: 'insert:image' },
      { label: '表格 / 编辑当前表格…', action: 'insert:table' },
      'separator',
      { label: '代码块…', action: 'insert:code' },
      { label: '数学公式…', action: 'insert:math' },
      { label: '流程图…', action: 'insert:mermaid' },
      { label: '分隔线', action: 'format:horizontalRule' },
    ],
  },
  {
    label: '视图',
    items: [
      { label: '即时渲染编辑', action: 'view:live' },
      { label: 'Markdown 源码', action: 'view:source' },
      { label: '阅读模式', action: 'view:read' },
      'separator',
      { label: '专注模式', action: 'view:focus' },
      { label: '显示 / 隐藏侧栏', action: 'view:sidebar' },
      { label: '文档并排对照', action: 'view:compare' },
      'separator',
      { label: '工作区管理', action: 'view:workspace' },
      { label: '版本历史', action: 'view:history' },
      { label: '反向链接', action: 'view:backlinks' },
      { label: '图片与附件', action: 'view:attachments' },
    ],
  },
  {
    label: '主题',
    items: [
      { label: '浅色', action: 'theme:light' },
      { label: '深色', action: 'theme:dark' },
      { label: '跟随系统', action: 'theme:system' },
      'separator',
      { label: '排版与主题设置…', action: 'app:settings', shortcut: 'Ctrl ,' },
    ],
  },
  {
    label: '工具',
    items: [
      { label: 'Git 版本管理', action: 'view:git' },
      { label: '上传图片到图床…', action: 'app:upload' },
      { label: '发布当前文档…', action: 'app:publish' },
      { label: '编辑扩展', action: 'app:extensions' },
      { label: 'AI 写作助手', action: 'app:ai' },
    ],
  },
  {
    label: '帮助',
    items: [
      { label: '快捷键', action: 'app:shortcuts' },
      { label: '关于墨页', action: 'app:about' },
    ],
  },
];
export default function EditingMenu({
  onAction,
  mode,
  theme,
  focus,
}: {
  onAction: (action: EditingAction) => void;
  mode: Mode;
  theme: 'light' | 'dark' | 'system';
  focus: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const focusItem = (index: number) =>
    requestAnimationFrame(() => {
      const items = root.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menu"] [role="menuitem"],[role="menu"] [role="menuitemradio"]',
      );
      if (items?.length) items[(index + items.length) % items.length].focus();
    });
  function menuKey(event: KeyboardEvent, index: number) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(null);
      root.current
        ?.querySelectorAll<HTMLButtonElement>('[role="menubar"] > .editing-menu-group > button')
        [index]?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(null);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setOpen((index + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length);
      focusItem(0);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menu"] [role="menuitem"],[role="menu"] [role="menuitemradio"]',
        ) || []),
      ];
      const selected = items.indexOf(document.activeElement as HTMLButtonElement);
      focusItem(
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : selected + (event.key === 'ArrowDown' ? 1 : -1),
      );
    }
  }
  function invoke(action: EditingAction) {
    setOpen(null);
    // Restore the editor's DOM focus before applying commands; CodeMirror retains its selection.
    returnFocus.current?.focus();
    onAction(action);
  }
  return (
    <nav className="editing-menubar" ref={root} aria-label="文档菜单">
      <div role="menubar" aria-label="菜单栏">
        {menus.map((menu, index) => (
          <div
            key={menu.label}
            className="editing-menu-group"
            onKeyDown={(event) => menuKey(event, index)}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === index}
              className={open === index ? 'is-open' : ''}
              onPointerDown={() => {
                if (open === null) returnFocus.current = document.activeElement as HTMLElement;
              }}
              onClick={() => setOpen(open === index ? null : index)}
              onMouseEnter={() => {
                if (open !== null) setOpen(index);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(index);
                  focusItem(0);
                }
              }}
            >
              {menu.label}
            </button>
            {open === index && (
              <div role="menu" aria-label={menu.label} className="editing-menu-popup">
                {menu.items.map((item, n) =>
                  item === 'separator' ? (
                    <div role="separator" key={n} />
                  ) : (
                    <button
                      role={
                        item.action.startsWith('theme:') ||
                        ['view:live', 'view:source', 'view:read'].includes(item.action)
                          ? 'menuitemradio'
                          : 'menuitem'
                      }
                      aria-checked={
                        item.action.startsWith('theme:')
                          ? item.action === `theme:${theme}`
                          : ['view:live', 'view:source', 'view:read'].includes(item.action)
                            ? item.action === `view:${mode}`
                            : undefined
                      }
                      tabIndex={-1}
                      key={item.action}
                      onClick={() => invoke(item.action)}
                    >
                      <span className="menu-check">
                        {item.action === `theme:${theme}` ||
                        item.action === `view:${mode}` ||
                        (item.action === 'view:focus' && focus)
                          ? '✓'
                          : ''}
                      </span>
                      <span>{item.label}</span>
                      {item.shortcut && <kbd>{item.shortcut}</kbd>}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <span className="editing-menu-hint">选中文字，使用菜单设置格式</span>
    </nav>
  );
}
