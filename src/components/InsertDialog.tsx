import { useEffect, useRef, useState } from 'react';
import { X, Plus, Minus } from 'lucide-react';
import {
  pasteTableCells,
  tableMarkdown,
  type TableModel,
  type TableAlignment,
} from '../editor/formatting';
import './editing.css';

export type InsertKind = 'link' | 'image' | 'table' | 'math' | 'mermaid' | 'code';
const names: Record<InsertKind, string> = {
  link: '插入链接',
  image: '插入图片',
  table: '表格编辑',
  math: '插入数学公式',
  mermaid: '插入流程图',
  code: '插入代码块',
};
const escapeLabel = (s: string) => s.replace(/[\\[\]]/g, '\\$&');
export default function InsertDialog({
  kind,
  onClose,
  onInsert,
  initialText = '',
  table: initialTable,
  onChooseImage,
  documents = [],
}: {
  kind: InsertKind;
  onClose: () => void;
  onInsert: (markdown: string) => void;
  initialText?: string;
  table?: TableModel;
  onChooseImage?: () => void;
  documents?: { name: string; path: string }[];
}) {
  const [label, setLabel] = useState(initialText);
  const [address, setAddress] = useState('');
  const [text, setText] = useState(
    kind === 'math' ? 'E = mc^2' : kind === 'mermaid' ? '开始\n处理\n完成' : initialText,
  );
  const [language, setLanguage] = useState('');
  const [inline, setInline] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [table, setTable] = useState<TableModel>(
    initialTable || {
      rows: [
        ['标题一', '标题二'],
        ['', ''],
        ['', ''],
      ],
      alignments: ['none', 'none'],
    },
  );
  const [active, setActive] = useState({ row: 0, column: 0 });
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input,textarea,select')?.focus();
    return () => previous?.focus();
  }, []);
  function resize(axis: 'row' | 'column', delta: 1 | -1) {
    setTable((old) => {
      const copy = { rows: old.rows.map((row) => [...row]), alignments: [...old.alignments] };
      if (axis === 'row') {
        if (delta === 1)
          copy.rows.splice(active.row + 1, 0, Array(copy.alignments.length).fill(''));
        else if (copy.rows.length > 2 && active.row > 0) copy.rows.splice(active.row, 1);
      } else {
        if (delta === 1) {
          copy.rows.forEach((row) => row.splice(active.column + 1, 0, ''));
          copy.alignments.splice(active.column + 1, 0, 'none');
        } else if (copy.alignments.length > 1) {
          copy.rows.forEach((row) => row.splice(active.column, 1));
          copy.alignments.splice(active.column, 1);
        }
      }
      setActive({
        row: Math.min(active.row, copy.rows.length - 1),
        column: Math.min(active.column, copy.alignments.length - 1),
      });
      return copy;
    });
  }
  function submit() {
    setError('');
    if (kind === 'link' || kind === 'image') {
      const url = address.trim();
      if (!url) {
        setError('请填写地址或相对路径。');
        return;
      }
      if (/[<>\r\n]/.test(url) || /^\s*(?:javascript|vbscript|data):/i.test(url)) {
        setError('请使用网页地址或本地相对路径。');
        return;
      }
      onInsert(
        `${kind === 'image' ? '!' : ''}[${escapeLabel(label || (kind === 'image' ? '图片' : url))}](<${url}>)`,
      );
    } else if (kind === 'table') onInsert(tableMarkdown(table));
    else if (kind === 'math') {
      if (!text.trim()) {
        setError('请选择或填写一个公式。');
        return;
      }
      onInsert(
        inline
          ? '$' + text.trim().replace(/\n/g, ' ') + '$'
          : '\n\n$$\n' + text.trim() + '\n$$\n\n',
      );
    } else if (kind === 'mermaid') {
      let code = text.trim();
      if (!advanced) {
        const steps = text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!steps.length) {
          setError('请填写至少一个步骤。');
          return;
        }
        code =
          'flowchart TD\n' +
          steps
            .map(
              (step, n) =>
                `  step${n}["${step.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[<>]/g, '')}"]`,
            )
            .join('\n') +
          '\n' +
          steps
            .slice(1)
            .map((_, n) => `  step${n} --> step${n + 1}`)
            .join('\n');
      }
      onInsert('\n\n```mermaid\n' + code + '\n```\n\n');
    } else {
      const fence = '`'.repeat(
        Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      onInsert(
        '\n\n' +
          fence +
          language.replace(/[^a-zA-Z0-9_+.-]/g, '') +
          '\n' +
          text +
          '\n' +
          fence +
          '\n\n',
      );
    }
  }
  return (
    <div
      className="insert-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className={`insert-dialog ${kind === 'table' ? 'insert-dialog-wide' : ''}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="insert-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
          if (event.key === 'Tab') {
            const items = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input,textarea,select',
              ) || []),
            ];
            if (event.shiftKey && document.activeElement === items[0]) {
              event.preventDefault();
              items.at(-1)?.focus();
            } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
              event.preventDefault();
              items[0]?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2 id="insert-dialog-title">{names[kind]}</h2>
            <p>
              {kind === 'table'
                ? '直接填写单元格，支持从 Excel / 表格粘贴。'
                : '填写内容即可插入，也可以随时切换到源码调整。'}
            </p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭插入窗口" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {(kind === 'link' || kind === 'image') && (
          <>
            {kind === 'image' && onChooseImage && (
              <button type="button" className="insert-file-button" onClick={onChooseImage}>
                选择本地图片…
              </button>
            )}
            {kind === 'link' && documents.length > 0 && (
              <label>
                链接到文档
                <select
                  value=""
                  onChange={(event) => {
                    const selected = documents.find((doc) => doc.path === event.target.value);
                    if (selected) {
                      setAddress(selected.path);
                      if (!label) setLabel(selected.name.replace(/\.(md|markdown)$/i, ''));
                    }
                  }}
                >
                  <option value="">选择已打开的文档</option>
                  {documents.map((doc) => (
                    <option key={doc.path} value={doc.path}>
                      {doc.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {kind === 'link' ? '显示文字' : '图片说明'}
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={kind === 'link' ? '例如：项目文档' : '例如：界面截图'}
              />
            </label>
            <label>
              {kind === 'link' ? '链接地址' : '图片地址或相对路径'}
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={
                  kind === 'link' ? 'https://example.com 或 ./说明.md' : 'assets/screenshot.png'
                }
              />
            </label>
            {kind === 'image' && (
              <p className="insert-help">
                本地图片也可以直接拖进正文，或复制图片后粘贴。网络图片需要在正文中主动加载。
              </p>
            )}
          </>
        )}
        {kind === 'table' && (
          <>
            <div className="table-grid-tools">
              <button type="button" onClick={() => resize('row', 1)}>
                <Plus size={14} />行
              </button>
              <button
                type="button"
                disabled={active.row === 0 || table.rows.length <= 2}
                onClick={() => resize('row', -1)}
              >
                <Minus size={14} />行
              </button>
              <button type="button" onClick={() => resize('column', 1)}>
                <Plus size={14} />列
              </button>
              <button
                type="button"
                disabled={table.alignments.length <= 1}
                onClick={() => resize('column', -1)}
              >
                <Minus size={14} />列
              </button>
              <span>
                {table.rows.length - 1} 行 × {table.alignments.length} 列
              </span>
            </div>
            <div className="table-grid-scroll">
              <table className="table-input-grid">
                <thead>
                  <tr>
                    {table.alignments.map((alignment, c) => (
                      <th key={c}>
                        <label>
                          第 {c + 1} 列对齐
                          <select
                            aria-label={`第 ${c + 1} 列对齐`}
                            value={alignment}
                            onChange={(event) =>
                              setTable((old) => ({
                                ...old,
                                alignments: old.alignments.map((value, n) =>
                                  n === c ? (event.target.value as TableAlignment) : value,
                                ),
                              }))
                            }
                          >
                            <option value="none">默认</option>
                            <option value="left">左对齐</option>
                            <option value="center">居中</option>
                            <option value="right">右对齐</option>
                          </select>
                        </label>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>
                          <input
                            aria-label={`${r === 0 ? '表头' : `第 ${r} 行`}第 ${c + 1} 列`}
                            value={cell}
                            placeholder={r === 0 ? '标题' : '内容'}
                            onFocus={() => setActive({ row: r, column: c })}
                            onChange={(event) =>
                              setTable((old) => ({
                                ...old,
                                rows: old.rows.map((line, n) =>
                                  n === r
                                    ? line.map((value, m) => (m === c ? event.target.value : value))
                                    : line,
                                ),
                              }))
                            }
                            onPaste={(event) => {
                              const text = event.clipboardData.getData('text/plain');
                              if (text.includes('\t') || text.includes('\n')) {
                                event.preventDefault();
                                setTable((old) => pasteTableCells(old, r, c, text));
                              }
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="insert-help">
              第一行是表头。增删操作作用于当前选中的行或列；保存后可从「插入 → 表格」继续修改。
            </p>
          </>
        )}
        {kind === 'code' && (
          <label>
            代码语言
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              <option value="">纯文本</option>
              {[
                'javascript',
                'typescript',
                'python',
                'rust',
                'bash',
                'json',
                'yaml',
                'html',
                'css',
                'cpp',
                'java',
                'sql',
              ].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        {kind === 'math' && (
          <>
            <label>
              常用公式
              <select
                onChange={(event) => {
                  if (event.target.value) setText(event.target.value);
                }}
                defaultValue=""
              >
                <option value="">选择公式模板</option>
                <option value="E = mc^2">质能方程</option>
                <option value="a^2 + b^2 = c^2">勾股定理</option>
                <option value="x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}">一元二次方程求根公式</option>
                <option value="\frac{a}{b}">分数</option>
                <option value="\sum_{i=1}^{n} i">求和</option>
                <option value="\int_a^b f(x)\,dx">积分</option>
              </select>
            </label>
            <label className="insert-toggle">
              <input
                type="checkbox"
                checked={inline}
                onChange={(event) => setInline(event.target.checked)}
              />
              插在文字行内
            </label>
          </>
        )}
        {kind === 'mermaid' && (
          <label className="insert-toggle">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => {
                setAdvanced(event.target.checked);
                setText(
                  event.target.checked ? 'flowchart TD\n  A[开始] --> B[完成]' : '开始\n处理\n完成',
                );
              }}
            />
            使用 Mermaid 源码
          </label>
        )}
        {['code', 'math', 'mermaid'].includes(kind) && (
          <label>
            {kind === 'code'
              ? '代码内容'
              : kind === 'math'
                ? '公式（支持 LaTeX）'
                : advanced
                  ? 'Mermaid 图表内容'
                  : '流程步骤，每行一个'}
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={kind === 'math' ? 4 : 8}
              spellCheck={false}
            />
          </label>
        )}
        {error && (
          <p className="insert-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary">
            {initialTable ? '更新表格' : '插入'}
          </button>
        </footer>
      </form>
    </div>
  );
}
