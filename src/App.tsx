import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import {
  FileText,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Plus,
  Settings as SettingsIcon,
  ChevronRight,
  ChevronDown,
  X,
  Check,
  Code2,
  BookOpen,
  PenLine,
  MoreHorizontal,
  ArrowUpRight,
  Command,
  Focus,
  Sun,
  Moon,
  FilePlus2,
  FolderPlus,
  Download,
  Save,
  Keyboard,
  ListTree,
  Files,
  AlertCircle,
  RefreshCw,
  ArrowLeft,
  Bold,
  Italic,
  Link as LinkIcon,
  Table,
  Image as ImageIcon,
  Quote,
  Heading2,
  Undo2,
  Redo2,
  SlidersHorizontal,
} from 'lucide-react';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { invoke } from '@tauri-apps/api/core';
import Editor, { releaseEditor } from './editor/Editor';
import Reader from './Reader';
import { findTable, changeTable, type TableAction } from './editor/table';
import * as platform from './lib/platform';
import {
  getHeadings,
  wordCount,
  renderMarkdown,
  hydrateDiagrams,
  escapeHtml,
} from './lib/markdown';
import { defaultSettings, readSession, writeSession } from './lib/recovery';
import { welcome, syntaxSample } from './lib/sample';
import type { Document, DiskFile, FileEntry, Mode, SearchHit, Settings } from './lib/types';
import katexCss from 'katex/dist/katex.min.css?inline';

const uid = () => crypto.randomUUID();
const basename = (path: string) =>
  path
    .split('/')
    .pop()
    ?.replace(/^file:/, '') || '未命名.md';
function draft(name: string, content = ''): Document {
  return {
    id: uid(),
    name,
    content,
    saved: content,
    bom: false,
    crlf: false,
    updated: Date.now(),
    status: 'clean',
  };
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const canceled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const recovered = readSession();
const initialDocs = recovered?.docs.length ? recovered.docs : [draft('开始写作.md', welcome)];
function IconButton({
  title,
  children,
  onClick,
  active,
  disabled,
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button,select')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Tab') {
        const elements = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,[tabindex="0"],textarea',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton title="关闭对话框" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
function FileTree({
  entries,
  active,
  onOpen,
  filter,
  depth = 0,
}: {
  entries: FileEntry[];
  active?: string;
  onOpen: (path: string) => void;
  filter: string;
  depth?: number;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const visible = (e: FileEntry): boolean =>
    e.name.toLowerCase().includes(filter.toLowerCase()) || !!e.children?.some(visible);
  return (
    <>
      {entries.filter(visible).map((entry) =>
        entry.directory ? (
          <div key={entry.path}>
            <button
              className="tree-row folder"
              style={{ paddingLeft: 13 + depth * 14 }}
              onClick={() =>
                setClosed((old) => {
                  const next = new Set(old);
                  next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
                  return next;
                })
              }
            >
              {closed.has(entry.path) && !filter ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
              <FolderOpen size={15} />
              <span>{entry.name}</span>
            </button>
            {(!closed.has(entry.path) || filter) && (
              <FileTree
                entries={entry.children || []}
                active={active}
                onOpen={onOpen}
                filter={filter}
                depth={depth + 1}
              />
            )}
          </div>
        ) : (
          <button
            key={entry.path}
            className={`tree-row ${entry.path === active ? 'selected' : ''}`}
            style={{ paddingLeft: 27 + depth * 14 }}
            onClick={() => onOpen(entry.path)}
            title={entry.path}
          >
            <FileText size={15} />
            <span>{entry.name.replace(/\.(md|markdown)$/i, '')}</span>
          </button>
        ),
      )}
    </>
  );
}
export default function App() {
  const [docs, setDocs] = useState<Document[]>(initialDocs);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const [activeId, setActiveId] = useState(
    recovered?.active && initialDocs.some((d) => d.id === recovered.active)
      ? recovered.active
      : initialDocs[0].id,
  );
  const [settings, setSettings] = useState<Settings>(recovered?.settings || defaultSettings);
  const [mode, setMode] = useState<Mode>('live');
  const [sidebar, setSidebar] = useState(true);
  const [sideTab, setSideTab] = useState<'files' | 'outline' | 'search'>('files');
  const [root, setRoot] = useState<string | undefined>(
    platform.desktop ? recovered?.root : undefined,
  );
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [focus, setFocus] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState(false);
  const [dialog, setDialog] = useState<
    'settings' | 'commands' | 'quickopen' | 'shortcuts' | 'conflict' | 'close' | null
  >(null);
  const [palette, setPalette] = useState('');
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState('');
  const [closeTarget, setCloseTarget] = useState<string>();
  const [diskConflict, setDiskConflict] = useState<(DiskFile & { documentId: string }) | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [namePrompt, setNamePrompt] = useState<{
    type: 'file' | 'folder' | 'rename';
    value: string;
  } | null>(null);
  const [sideWidth, setSideWidth] = useState(248);
  const editor = useRef<EditorView | null>(null);
  const saving = useRef(new Set<string>());
  const composing = useRef(false);
  const exitAfterSave = useRef(false);
  const current = docs.find((d) => d.id === activeId) || docs[0];
  const currentRef = useRef(current);
  currentRef.current = current;
  const actions = useRef<{
    save: () => void;
    open: () => void;
    new: () => void;
    close: () => void;
  }>({ save: () => {}, open: () => {}, new: () => {}, close: () => {} });
  const headings = useMemo(() => getHeadings(current?.content || ''), [current?.content]);
  const activeTable = useMemo(
    () => findTable(current?.content || '', position.line),
    [current?.content, position.line],
  );
  const words = useMemo(() => wordCount(current?.content || ''), [current?.content]);
  function updateDocs(fn: (items: Document[]) => Document[]) {
    const next = fn(docsRef.current);
    docsRef.current = next;
    setDocs(next);
  }
  function patch(id: string, change: Partial<Document>) {
    updateDocs((items) => items.map((d) => (d.id === id ? { ...d, ...change } : d)));
  }
  function notify(message: string) {
    setToast(message);
  }
  function contentChanged(id: string, content: string) {
    updateDocs((items) =>
      items.map((d) =>
        d.id !== id
          ? d
          : {
              ...d,
              content,
              updated: Date.now(),
              status:
                d.status === 'conflict' ? 'conflict' : content === d.saved ? 'clean' : 'dirty',
              error: undefined,
            },
      ),
    );
    setSelection(!!editor.current && !editor.current.state.selection.main.empty);
  }
  function addDisk(file: DiskFile) {
    const existing = docsRef.current.find((d) => d.path && d.path === file.path);
    if (existing) {
      setActiveId(existing.id);
      if (existing.content !== existing.saved && existing.version !== file.version)
        patch(existing.id, { status: 'conflict' });
      else if (existing.content === existing.saved)
        patch(existing.id, { ...file, saved: file.content, status: 'clean' });
      return;
    }
    const d: Document = {
      ...draft(basename(file.path), file.content),
      ...file,
      path: file.path || undefined,
      saved: file.content,
    };
    updateDocs((items) => [...items, d]);
    setActiveId(d.id);
  }
  async function openFiles() {
    try {
      const files = await platform.openFiles();
      files.forEach(addDisk);
    } catch (e) {
      if (!canceled(e)) notify(errorText(e));
    }
  }
  async function openFolder() {
    try {
      const folder = await platform.openFolder();
      if (folder) {
        setRoot(folder.path);
        setEntries(folder.entries);
        setSideTab('files');
        setSidebar(true);
      }
    } catch (e) {
      if (!canceled(e)) notify(errorText(e));
    }
  }
  async function refresh() {
    if (root)
      try {
        setEntries(await platform.listFolder(root));
      } catch (e) {
        notify(errorText(e));
      }
  }
  async function openPath(path: string, line?: number) {
    const existing = docsRef.current.find((d) => d.path === path);
    try {
      if (existing) setActiveId(existing.id);
      else addDisk(await platform.readFile(path));
      if (line) setTimeout(() => jump(line), 80);
    } catch (e) {
      notify(errorText(e));
    }
  }
  function newDocument() {
    const d = draft(`未命名 ${docsRef.current.filter((d) => !d.path).length + 1}.md`);
    updateDocs((items) => [...items, d]);
    setActiveId(d.id);
    setMode('live');
    setTimeout(() => editor.current?.focus(), 0);
  }
  async function save(id = currentRef.current?.id, asNew = false) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d || saving.current.has(d.id)) return false;
    if (d.status === 'conflict' && !asNew) {
      await showConflict(d);
      return false;
    }
    if (d.path && d.content === d.saved && !asNew) {
      notify('文件已保存');
      return true;
    }
    saving.current.add(d.id);
    patch(d.id, { status: 'saving' });
    try {
      const result =
        !d.path || asNew
          ? await platform.saveAs(d.content, d.name)
          : await platform.writeFile({
              path: d.path,
              content: d.content,
              version: d.version || '',
              bom: d.bom,
              crlf: d.crlf,
            });
      if (!result) {
        patch(d.id, { status: d.content === d.saved ? 'clean' : 'dirty' });
        return false;
      }
      updateDocs((items) =>
        items.map((item) =>
          item.id === d.id
            ? {
                ...item,
                path: result.path,
                name: basename(result.path),
                version: result.version,
                bom: result.bom,
                crlf: result.crlf,
                saved: d.content,
                status: item.content === d.content ? 'clean' : 'dirty',
                error: undefined,
              }
            : item,
        ),
      );
      if (root) void refresh();
      return true;
    } catch (e) {
      if (canceled(e)) {
        patch(d.id, { status: d.content === d.saved ? 'clean' : 'dirty' });
        return false;
      }
      const message = errorText(e);
      patch(d.id, { status: message.includes('CONFLICT:') ? 'conflict' : 'error', error: message });
      notify(message.replace('CONFLICT:', ''));
      return false;
    } finally {
      saving.current.delete(d.id);
    }
  }
  async function showConflict(d = currentRef.current) {
    if (!d?.path) return;
    try {
      const disk = await platform.readFile(d.path);
      setActiveId(d.id);
      setDiskConflict({ ...disk, documentId: d.id });
      setDialog('conflict');
    } catch (e) {
      notify(`${errorText(e)} 可使用“另存为”保留当前内容。`);
    }
  }
  function removeDoc(id: string) {
    const next = docsRef.current.filter((d) => d.id !== id);
    releaseEditor(id);
    if (!next.length) next.push(draft('未命名.md'));
    updateDocs(() => next);
    if (activeId === id) setActiveId(next[Math.max(0, next.length - 1)].id);
  }
  function requestClose(id = currentRef.current?.id) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d) return;
    if (d.content !== d.saved || d.status === 'conflict' || d.status === 'error') {
      setCloseTarget(d.id);
      setDialog('close');
    } else removeDoc(d.id);
  }
  function jump(line: number) {
    if (mode === 'read') {
      const h = headings.find((h) => h.line === line);
      if (h) document.getElementById(h.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const view = editor.current;
    if (!view) return;
    const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 44 }),
    });
    view.focus();
  }
  function insert(before: string, after = '', fallback = '') {
    const view = editor.current;
    if (!view || mode === 'read') return;
    const r = view.state.selection.main;
    const text = view.state.sliceDoc(r.from, r.to) || fallback;
    view.dispatch({
      changes: { from: r.from, to: r.to, insert: before + text + after },
      selection: { anchor: r.from + before.length, head: r.from + before.length + text.length },
      userEvent: 'input',
    });
    view.focus();
  }
  async function image(file: File) {
    const d = currentRef.current,
      view = editor.current;
    if (!d || !view) return;
    if (file.size > 20 * 1024 * 1024) {
      notify('图片超过 20MB，请先压缩。');
      return;
    }
    try {
      const path = await platform.attachImage(d.path, file);
      if (currentRef.current.id !== d.id) {
        notify('图片已处理，请回到原文档后重新插入。');
        return;
      }
      insert(`![${file.name.replace(/[\[\]]/g, '')}](${path})\n`);
    } catch (e) {
      notify(errorText(e));
    }
  }
  function editTable(action: TableAction) {
    const view = editor.current;
    if (!view) return;
    const change = changeTable(current.content, position.line, position.column, action);
    if (!change) {
      notify('至少保留一列、一行正文；表头不能作为正文行删除。');
      return;
    }
    view.dispatch({ changes: change, selection: { anchor: change.from }, userEvent: 'input' });
    view.focus();
  }
  function chooseImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
    input.onchange = () => {
      if (input.files?.[0]) void image(input.files[0]);
    };
    input.click();
  }
  async function followLink(href: string) {
    if (/^https?:\/\//.test(href)) {
      try {
        await platform.openExternal(href);
      } catch (e) {
        notify(errorText(e));
      }
      return;
    }
    if (href.startsWith('#')) return;
    const path = currentRef.current?.path;
    if (!path || /^[a-z]+:/i.test(href)) {
      notify('请先保存文档，再打开相对链接。');
      return;
    }
    try {
      const decoded = decodeURIComponent(href.split('#')[0]);
      await openPath(`${path.slice(0, path.lastIndexOf('/'))}/${decoded}`);
    } catch (e) {
      notify(`无法打开链接：${errorText(e)}`);
    }
  }
  async function doExport() {
    if (!current || exporting) return;
    setExporting(true);
    setMenu(false);
    const node = document.createElement('article');
    node.className = 'markdown-body';
    node.innerHTML = renderMarkdown(current.content);
    try {
      await hydrateDiagrams(node);
      for (const img of node.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
        if (!current.path) throw new Error('图片路径无法解析，请先保存文档或打开所在文件夹。');
        img.src = await platform.assetData(current.path, img.dataset.asset!);
        img.removeAttribute('data-asset');
        img.classList.remove('pending-image');
      }
      let mathCss = katexCss;
      if (node.querySelector('.katex')) {
        const urls = [
          ...new Set(
            [...mathCss.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/["']/g, '')),
          ),
        ];
        for (const url of urls.filter((u) => !u.startsWith('data:'))) {
          const response = await fetch(url);
          if (!response.ok) throw new Error('无法嵌入公式字体。');
          const blob = await response.blob();
          const data = await new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.readAsDataURL(blob);
          });
          mathCss = mathCss.split(url).join(data);
        }
      }
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(current.name)}</title><style>body{max-width:800px;margin:60px auto;padding:0 28px;color:#24272e;font:17px/1.85 system-ui,sans-serif}h1,h2,h3{line-height:1.4}h1{font-size:2em}h2{margin-top:2em}a{color:#4361d9}pre{padding:20px;background:#f3f4f6;overflow:auto;border-radius:8px}code{font-family:monospace}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;border:1px solid #e4e7ec;text-align:left}blockquote{border-left:3px solid #4361d9;margin-left:0;padding-left:20px;color:#657080}img,svg{max-width:100%}hr{border:0;border-top:1px solid #e4e7ec;margin:32px 0}${mathCss}</style></head><body>${node.outerHTML}</body></html>`;
      if (await platform.exportHtml(html, current.name.replace(/\.(md|markdown)$/i, '') + '.html'))
        notify('HTML 已导出，可离线查看');
    } catch (e) {
      if (!canceled(e)) notify(`导出未完成：${errorText(e)}`);
    } finally {
      setExporting(false);
    }
  }
  async function submitName() {
    if (!namePrompt) return;
    if (saving.current.has(current.id)) {
      notify('文档正在保存，请稍后再重命名。');
      return;
    }
    try {
      if (namePrompt.type === 'rename' && current.path) {
        const newPath = await platform.renameFile(current.path, namePrompt.value);
        patch(current.id, { path: newPath, name: basename(newPath) });
      } else if (namePrompt.type === 'rename')
        patch(current.id, {
          name: namePrompt.value.endsWith('.md') ? namePrompt.value : `${namePrompt.value}.md`,
        });
      else if (root) {
        const name =
          namePrompt.type === 'file' && !/\.(md|markdown)$/.test(namePrompt.value)
            ? `${namePrompt.value}.md`
            : namePrompt.value;
        const p = await platform.createEntry(root, name, namePrompt.type === 'folder');
        if (namePrompt.type === 'file') await openPath(p);
      }
      setNamePrompt(null);
      await refresh();
    } catch (e) {
      notify(errorText(e));
    }
  }
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        writeSession(docsRef.current, activeId, settings, root);
      } catch {
        notify('草稿恢复空间不足。请立即保存到文件，避免丢失当前修改。');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [docs, activeId, settings, root]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!platform.desktop) return;
    if (root) void refresh();
    void invoke<DiskFile[]>('initial_documents')
      .then((files) => files.forEach(addDisk))
      .catch((e) => notify(errorText(e)));
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!settings.autosave || composing.current) return;
      for (const d of docsRef.current)
        if (d.path && d.status === 'dirty' && Date.now() - d.updated > 800) void save(d.id);
    }, 400);
    return () => clearInterval(timer);
  }, [settings.autosave]);
  useEffect(() => {
    let checking = false,
      stopped = false;
    const check = async () => {
      if (checking || composing.current) return;
      checking = true;
      for (const d of [...docsRef.current]) {
        if (!d.path || saving.current.has(d.id) || d.status === 'conflict') continue;
        try {
          const file = await platform.readFile(d.path);
          if (stopped) break;
          const latest = docsRef.current.find((x) => x.id === d.id);
          if (
            !latest ||
            latest.version !== d.version ||
            saving.current.has(d.id) ||
            file.version === d.version
          )
            continue;
          if (latest.content !== latest.saved)
            patch(d.id, { status: 'conflict', error: '磁盘文件已修改，请比较版本。' });
          else patch(d.id, { ...file, saved: file.content, status: 'clean' });
        } catch {
          /* Save surfaces path failures; background scans never erase the current buffer. */
        }
      }
      checking = false;
    };
    const timer = setInterval(() => {
      void check();
    }, 2200);
    window.addEventListener('focus', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);
  useEffect(() => {
    let canceled = false;
    if (!query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const disk = root ? await platform.searchFolder(root, query) : [];
        const openedPaths = new Set(docsRef.current.map((d) => d.path || d.id));
        const fromBuffers = docsRef.current.flatMap((d) =>
          d.content
            .split('\n')
            .flatMap((text, i) =>
              text.toLowerCase().includes(query.toLowerCase())
                ? [{ path: d.path || d.id, line: i + 1, text }]
                : [],
            ),
        );
        if (!canceled)
          setHits([...fromBuffers, ...disk.filter((h) => !openedPaths.has(h.path))].slice(0, 500));
      } catch (e) {
        if (!canceled) notify(errorText(e));
      } finally {
        if (!canceled) setSearching(false);
      }
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [query, root, docs]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      try {
        writeSession(docsRef.current, activeId, settings, root);
      } catch {
        e.preventDefault();
        e.returnValue = '';
      }
      if (!platform.desktop && docsRef.current.some((d) => d.content !== d.saved)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (platform.desktop)
      void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const fn = await getCurrentWindow().onCloseRequested((event) => {
          if (exitAfterSave.current) return;
          if (docsRef.current.some((d) => d.content !== d.saved || d.status === 'conflict')) {
            event.preventDefault();
            setCloseTarget('app');
            setDialog('close');
          } else
            try {
              writeSession(docsRef.current, activeId, settings, root);
            } catch {
              event.preventDefault();
              notify('无法保存会话，请先另存文档。');
            }
        });
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener('beforeunload', before);
    };
  }, [activeId, settings, root]);
  actions.current = {
    save: () => {
      void save();
    },
    open: () => {
      void openFiles();
    },
    new: newDocument,
    close: () => requestClose(),
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        setMenu(false);
        if (!dialog) setFocus(false);
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setPalette('');
        setDialog('commands');
      } else if (key === 'p') {
        e.preventDefault();
        setPalette('');
        setDialog('quickopen');
      } else if (key === 's') {
        e.preventDefault();
        actions.current.save();
      } else if (key === 'o') {
        e.preventDefault();
        actions.current.open();
      } else if (key === 'n') {
        e.preventDefault();
        actions.current.new();
      } else if (key === 'w') {
        e.preventDefault();
        actions.current.close();
      } else if (key === ',') {
        e.preventDefault();
        setDialog('settings');
      } else if (key === 'f' && e.shiftKey) {
        e.preventDefault();
        setSideTab('search');
        setSidebar(true);
      } else if (key === 'f' && mode === 'read') {
        e.preventDefault();
        setMode('source');
        setTimeout(() => {
          if (editor.current) openSearchPanel(editor.current);
        }, 0);
      } else if (key === '\\') {
        e.preventDefault();
        setSidebar((v) => !v);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [dialog, mode]);
  const commands = [
    { label: '新建文档', hint: 'Ctrl N', icon: <FilePlus2 size={18} />, run: newDocument },
    {
      label: '打开 Markdown 文件',
      hint: 'Ctrl O',
      icon: <FileText size={18} />,
      run: () => void openFiles(),
    },
    { label: '打开文件夹', hint: '', icon: <FolderOpen size={18} />, run: () => void openFolder() },
    { label: '保存文档', hint: 'Ctrl S', icon: <Save size={18} />, run: () => void save() },
    {
      label: '另存为…',
      hint: '',
      icon: <Save size={18} />,
      run: () => void save(current.id, true),
    },
    { label: '导出 HTML', hint: '', icon: <Download size={18} />, run: () => void doExport() },
    {
      label: '查找与替换',
      hint: 'Ctrl F',
      icon: <Search size={18} />,
      run: () => {
        setMode('source');
        if (editor.current) openSearchPanel(editor.current);
      },
    },
    {
      label: focus ? '退出专注模式' : '进入专注模式',
      hint: '',
      icon: <Focus size={18} />,
      run: () => setFocus((v) => !v),
    },
    {
      label: '切换浅色 / 深色主题',
      hint: '',
      icon: <Moon size={18} />,
      run: () =>
        setSettings((s) => ({
          ...s,
          theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark',
        })),
    },
    {
      label: '设置',
      hint: 'Ctrl ,',
      icon: <SettingsIcon size={18} />,
      run: () => setTimeout(() => setDialog('settings'), 0),
    },
  ];
  const allFiles = (nodes: FileEntry[]): FileEntry[] =>
    nodes.flatMap((n) => (n.children ? allFiles(n.children) : [n]));
  const quickFiles = [
    ...docs.map((d) => ({ name: d.name, path: d.path || d.id, id: d.id })),
    ...allFiles(entries)
      .filter((e) => !docs.some((d) => d.path === e.path))
      .map((e) => ({ ...e, id: '' })),
  ].filter((e) => e.name.toLowerCase().includes(palette.toLowerCase()));
  async function finishClose(keepDraft: boolean) {
    if (closeTarget === 'app') {
      if (!keepDraft)
        for (const d of [...docsRef.current]) {
          if (d.content !== d.saved && !(await save(d.id))) return;
        }
      try {
        writeSession(docsRef.current, activeId, settings, root);
      } catch {
        notify('草稿保存失败，请先另存文件。');
        return;
      }
      exitAfterSave.current = true;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } else if (closeTarget) {
      if (!keepDraft && !(await save(closeTarget))) return;
      removeDoc(closeTarget);
    }
    setDialog(null);
  }
  return (
    <div
      className={`app ${focus ? 'focus-mode' : ''} ${!sidebar ? 'sidebar-collapsed' : ''}`}
      style={
        {
          '--sidebar-width': `${sideWidth}px`,
          '--editor-size': `${settings.fontSize}px`,
          '--editor-line': settings.lineHeight,
          '--content-width': `${settings.width}px`,
          '--body-font': settings.serif
            ? '"Noto Serif CJK SC", "Source Han Serif SC", serif'
            : '"Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif',
        } as CSSProperties
      }
    >
      {sidebar && !focus && (
        <aside className="sidebar">
          <div className="brand">
            <img src="/assets/app-icon.png" alt="" />
            <span>
              墨页<small>MARKWRITE</small>
            </span>
            <IconButton title="收起侧栏" onClick={() => setSidebar(false)}>
              <PanelLeftClose size={17} />
            </IconButton>
          </div>
          <button
            className="quick-search"
            onClick={() => {
              setPalette('');
              setDialog('quickopen');
            }}
          >
            <Search size={15} />
            <span>搜索文档</span>
            <kbd>Ctrl P</kbd>
          </button>
          <div className="sidebar-navigation">
            <button
              className={sideTab === 'files' ? 'active' : ''}
              onClick={() => setSideTab('files')}
            >
              <Files size={15} />
              文档
            </button>
            <button
              className={sideTab === 'outline' ? 'active' : ''}
              onClick={() => setSideTab('outline')}
            >
              <ListTree size={15} />
              大纲
            </button>
            <IconButton
              title="全文搜索 · Ctrl Shift F"
              active={sideTab === 'search'}
              onClick={() => setSideTab('search')}
            >
              <Search size={16} />
            </IconButton>
          </div>
          <div className="sidebar-content">
            {sideTab === 'files' && (
              <>
                <div className="section-caption">
                  <span>当前打开</span>
                  <IconButton title="新建文档 · Ctrl N" onClick={newDocument}>
                    <Plus size={15} />
                  </IconButton>
                </div>
                {docs.map((d) => (
                  <button
                    key={d.id}
                    className={`tree-row document-row ${d.id === current.id ? 'selected' : ''}`}
                    onClick={() => setActiveId(d.id)}
                    title={d.path || d.name}
                  >
                    <FileText size={16} />
                    <span>{d.name.replace(/\.(md|markdown)$/i, '')}</span>
                    {d.content !== d.saved && <i className="dirty-dot" />}
                  </button>
                ))}
                <div className="section-caption workspace-caption">
                  <span>{root ? basename(root) : '工作文件夹'}</span>
                  <div>
                    {root && (
                      <>
                        <IconButton
                          title="新建文件夹"
                          onClick={() => setNamePrompt({ type: 'folder', value: '' })}
                        >
                          <FolderPlus size={14} />
                        </IconButton>
                        <IconButton
                          title="新建文件"
                          onClick={() => setNamePrompt({ type: 'file', value: '' })}
                        >
                          <FilePlus2 size={14} />
                        </IconButton>
                        <IconButton title="刷新文件树" onClick={() => void refresh()}>
                          <RefreshCw size={13} />
                        </IconButton>
                      </>
                    )}
                  </div>
                </div>
                {root ? (
                  <>
                    <div className="tree-filter">
                      <Search size={13} />
                      <input
                        aria-label="筛选文件名"
                        placeholder="筛选文件…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                    </div>
                    <FileTree
                      entries={entries}
                      active={current.path}
                      onOpen={(p) => void openPath(p)}
                      filter={filter}
                    />
                    {entries.length === 0 && (
                      <p className="side-empty">
                        还没有 Markdown 文档
                        <br />
                        点击上方 + 新建一篇。
                      </p>
                    )}
                  </>
                ) : (
                  <div className="folder-empty">
                    <FolderOpen size={25} strokeWidth={1.4} />
                    <p>把整个项目，放在手边</p>
                    <button onClick={() => void openFolder()}>
                      打开文件夹 <ArrowUpRight size={13} />
                    </button>
                  </div>
                )}
                <div className="section-caption">
                  <span>开始探索</span>
                </div>
                <button
                  className="tree-row"
                  onClick={() => {
                    const existing = docs.find((d) => d.name === 'Markdown 语法手册.md');
                    if (existing) setActiveId(existing.id);
                    else {
                      const d = draft('Markdown 语法手册.md', syntaxSample);
                      updateDocs((items) => [...items, d]);
                      setActiveId(d.id);
                    }
                  }}
                >
                  <BookOpen size={16} />
                  <span>Markdown 语法手册</span>
                </button>
              </>
            )}
            {sideTab === 'outline' && (
              <>
                <div className="section-caption">
                  <span>文档结构</span>
                  <span>{headings.length}</span>
                </div>
                {headings.length ? (
                  headings.map((h) => (
                    <button
                      key={`${h.line}-${h.id}`}
                      className={`outline-row ${position.line === h.line ? 'selected' : ''}`}
                      style={{ paddingLeft: 16 + (h.level - 1) * 13 }}
                      onClick={() => jump(h.line)}
                    >
                      <span className="outline-level">H{h.level}</span>
                      <span>{h.text}</span>
                    </button>
                  ))
                ) : (
                  <p className="side-empty">
                    用 # 写下第一个标题，
                    <br />
                    大纲就会出现在这里。
                  </p>
                )}
              </>
            )}
            {sideTab === 'search' && (
              <>
                <div className="section-caption">
                  <span>搜索内容</span>
                  <span>{searching ? '搜索中…' : `${hits.length} 条`}</span>
                </div>
                <div className="tree-filter search-input">
                  <Search size={14} />
                  <input
                    autoFocus
                    placeholder="在文档中搜索…"
                    aria-label="全文搜索关键词"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button aria-label="清除搜索" onClick={() => setQuery('')}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                <p className="search-scope">{root ? '当前文件夹与打开的文档' : '当前打开的文档'}</p>
                {hits.map((hit, i) => (
                  <button
                    key={`${hit.path}-${hit.line}-${i}`}
                    className="search-hit"
                    onClick={() => {
                      const d = docs.find((d) => d.id === hit.path || d.path === hit.path);
                      if (d) {
                        setActiveId(d.id);
                        setTimeout(() => jump(hit.line), 80);
                      } else void openPath(hit.path, hit.line);
                    }}
                  >
                    <strong>
                      {docs.find((d) => d.id === hit.path)?.name || basename(hit.path)}
                      <small>{hit.line}</small>
                    </strong>
                    <span>{hit.text}</span>
                  </button>
                ))}
                {query && !hits.length && !searching && (
                  <p className="side-empty">
                    没有找到匹配内容。
                    <br />
                    试试更短的关键词。
                  </p>
                )}
              </>
            )}
          </div>
          <div className="sidebar-bottom">
            <button onClick={() => setDialog('settings')}>
              <SettingsIcon size={16} />
              <span>设置</span>
              <kbd>Ctrl ,</kbd>
            </button>
            <div className="local-note">
              <span className="local-dot" />
              本地优先 · 安心写作
              <IconButton title="快捷键" onClick={() => setDialog('shortcuts')}>
                <Keyboard size={15} />
              </IconButton>
            </div>
          </div>
          <div
            className="sidebar-resize"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                setSideWidth(Math.max(210, Math.min(380, e.clientX)));
            }}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          />
        </aside>
      )}
      <main className="main">
        {!focus && (
          <header className="topbar">
            <div className="breadcrumb">
              {!sidebar && (
                <IconButton title="展开侧栏" onClick={() => setSidebar(true)}>
                  <PanelLeftOpen size={18} />
                </IconButton>
              )}
              <span>{root ? basename(root) : '我的文档'}</span>
              <ChevronRight size={13} />
              <strong title={current.path}>{current.name}</strong>
              {!current.path && <span className="draft-label">草稿</span>}
            </div>
            <div className="top-actions">
              <div className="mode-switch" aria-label="文档模式">
                <button
                  title="即时渲染编辑"
                  className={mode === 'live' ? 'active' : ''}
                  onClick={() => setMode('live')}
                >
                  <PenLine size={14} />
                  <span>编辑</span>
                </button>
                <button
                  title="Markdown 源码"
                  className={mode === 'source' ? 'active' : ''}
                  onClick={() => setMode('source')}
                >
                  <Code2 size={15} />
                  <span>源码</span>
                </button>
                <button
                  title="只读模式"
                  className={mode === 'read' ? 'active' : ''}
                  onClick={() => setMode('read')}
                >
                  <BookOpen size={14} />
                  <span>阅读</span>
                </button>
              </div>
              <span className="action-divider" />
              <IconButton title="专注模式" onClick={() => setFocus(true)}>
                <Focus size={17} />
              </IconButton>
              <div className="menu-anchor">
                <IconButton title="更多操作" active={menu} onClick={() => setMenu((v) => !v)}>
                  <MoreHorizontal size={19} />
                </IconButton>
                {menu && (
                  <>
                    <div className="menu-dismiss" onClick={() => setMenu(false)} />
                    <div className="dropdown">
                      <button
                        onClick={() => {
                          setMenu(false);
                          void save();
                        }}
                      >
                        <Save size={15} />
                        保存<span>Ctrl S</span>
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          void save(current.id, true);
                        }}
                      >
                        <FilePlus2 size={15} />
                        另存为…
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          setNamePrompt({ type: 'rename', value: current.name });
                        }}
                      >
                        <PenLine size={15} />
                        重命名
                      </button>
                      <hr />
                      <button disabled={exporting} onClick={() => void doExport()}>
                        <Download size={15} />
                        {exporting ? '正在导出…' : '导出 HTML'}
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          setDialog('settings');
                        }}
                      >
                        <SlidersHorizontal size={15} />
                        排版与设置
                      </button>
                      <button
                        onClick={() => {
                          setMenu(false);
                          setDialog('shortcuts');
                        }}
                      >
                        <Keyboard size={15} />
                        快捷键
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>
        )}
        {docs.length > 1 && !focus && (
          <div className="tabs">
            {docs.map((d) => (
              <div key={d.id} className={`tab ${d.id === current.id ? 'active' : ''}`}>
                <button onClick={() => setActiveId(d.id)}>
                  <FileText size={13} />
                  <span>{d.name}</span>
                  {d.content !== d.saved && <i className="dirty-dot" />}
                </button>
                <IconButton title={`关闭 ${d.name}`} onClick={() => requestClose(d.id)}>
                  <X size={12} />
                </IconButton>
              </div>
            ))}
            <IconButton title="新建文档" onClick={newDocument}>
              <Plus size={15} />
            </IconButton>
          </div>
        )}
        {(current.status === 'conflict' || current.status === 'error') && (
          <div className="document-alert">
            <AlertCircle size={16} />
            <span>
              {current.status === 'conflict'
                ? '磁盘上的文件发生了变化，自动保存已暂停。'
                : current.error || '保存失败，当前内容已保留。'}
            </span>
            <button
              onClick={() => (current.status === 'conflict' ? void showConflict() : void save())}
            >
              {current.status === 'conflict' ? '比较版本' : '重试保存'}
            </button>
            <button onClick={() => void save(current.id, true)}>另存为</button>
          </div>
        )}
        {current.content.length > 300_000 && mode === 'live' && (
          <div className="performance-note">
            当前文档较大，已暂停即时渲染以保证编辑响应。仍可使用源码和阅读模式。
          </div>
        )}
        <div className="document-surface">
          <Editor
            id={current.id}
            content={current.content}
            path={current.path}
            mode={mode}
            onChange={(text) => contentChanged(current.id, text)}
            onReady={(v) => {
              editor.current = v;
            }}
            onSelection={(line, column) => {
              setPosition({ line, column });
              setSelection(!!editor.current && !editor.current.state.selection.main.empty);
            }}
            onImage={(file) => void image(file)}
            onComposition={(v) => {
              composing.current = v;
            }}
          />
          {mode === 'read' && (
            <Reader
              content={current.content}
              path={current.path}
              onLink={(href) => void followLink(href)}
            />
          )}
          {mode !== 'read' && activeTable && (
            <div className="table-actions" onMouseDown={(e) => e.preventDefault()}>
              <span>表格</span>
              <button onClick={() => editTable('addRow')}>添加行</button>
              <button onClick={() => editTable('addColumn')}>添加列</button>
              <button onClick={() => editTable('removeRow')}>删除行</button>
              <button onClick={() => editTable('removeColumn')}>删除列</button>
            </div>
          )}
          {mode !== 'read' && selection && (
            <div className="format-bar" onMouseDown={(e) => e.preventDefault()}>
              <IconButton title="粗体" onClick={() => insert('**', '**', '粗体文字')}>
                <Bold size={15} />
              </IconButton>
              <IconButton title="斜体" onClick={() => insert('*', '*', '斜体文字')}>
                <Italic size={15} />
              </IconButton>
              <IconButton
                title="插入链接"
                onClick={() => insert('[', '](https://example.com)', '链接文字')}
              >
                <LinkIcon size={15} />
              </IconButton>
              <IconButton title="行内代码" onClick={() => insert('`', '`', '代码')}>
                <Code2 size={15} />
              </IconButton>
              <IconButton title="引用" onClick={() => insert('> ')}>
                <Quote size={15} />
              </IconButton>
            </div>
          )}
        </div>
        {focus && (
          <button className="exit-focus" onClick={() => setFocus(false)}>
            <ArrowLeft size={14} />
            退出专注 <kbd>Esc</kbd>
          </button>
        )}
        {!focus && (
          <footer className="statusbar">
            <button
              className={`save-state ${current.status}`}
              onClick={() => void save()}
              title={current.path || '选择位置保存为 Markdown 文件'}
            >
              {current.status === 'clean' ? (
                <Check size={13} />
              ) : current.status === 'saving' ? (
                <RefreshCw size={13} className="spin" />
              ) : current.status === 'conflict' || current.status === 'error' ? (
                <AlertCircle size={13} />
              ) : (
                <span className="dirty-dot" />
              )}
              {
                {
                  clean: current.path ? '已保存' : '草稿已暂存',
                  dirty: '未保存',
                  saving: '保存中…',
                  error: '保存失败',
                  conflict: '文件冲突',
                }[current.status]
              }
            </button>
            <div className="status-right">
              <span>{words.toLocaleString()} 字</span>
              <i />
              <span>
                行 {position.line}，列 {position.column}
              </span>
              <i />
              <span>UTF-8{current.bom ? ' BOM' : ''}</span>
              <span>{current.crlf ? 'CRLF' : 'LF'}</span>
              <button title="排版设置" onClick={() => setDialog('settings')}>
                {settings.fontSize}px
              </button>
              <IconButton
                title="打开命令面板 · Ctrl K"
                onClick={() => {
                  setPalette('');
                  setDialog('commands');
                }}
              >
                <Command size={13} />
              </IconButton>
            </div>
          </footer>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {(dialog === 'commands' || dialog === 'quickopen') && (
        <Modal
          title={dialog === 'commands' ? '想做些什么？' : '跳转到文档'}
          subtitle={
            dialog === 'commands' ? '所有操作，都在这里。' : '搜索已打开的文档和工作文件夹。'
          }
          onClose={() => setDialog(null)}
        >
          <div className="palette-search">
            <Search size={19} />
            <input
              autoFocus
              aria-label={dialog === 'commands' ? '搜索操作' : '搜索文件'}
              placeholder={dialog === 'commands' ? '搜索操作…' : '输入文件名…'}
              value={palette}
              onChange={(e) => setPalette(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (dialog === 'commands') commands.find((c) => c.label.includes(palette))?.run();
                  else {
                    const f = quickFiles[0];
                    if (f) {
                      if (f.id) setActiveId(f.id);
                      else void openPath(f.path);
                    }
                  }
                  setDialog(null);
                }
              }}
            />
            <kbd>Esc</kbd>
          </div>
          <div className="palette-results">
            {dialog === 'commands'
              ? commands
                  .filter((c) => c.label.includes(palette))
                  .map((c) => (
                    <button
                      key={c.label}
                      onClick={() => {
                        setDialog(null);
                        c.run();
                      }}
                    >
                      {c.icon}
                      <span>{c.label}</span>
                      <kbd>{c.hint}</kbd>
                    </button>
                  ))
              : quickFiles.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => {
                      setDialog(null);
                      if (f.id) setActiveId(f.id);
                      else void openPath(f.path);
                    }}
                  >
                    <FileText size={17} />
                    <span>
                      {f.name}
                      <small>{f.id ? '已打开' : f.path}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
            {dialog === 'quickopen' && !quickFiles.length && (
              <p className="empty-results">没有找到文档，试试其他关键词。</p>
            )}
          </div>
          <div className="palette-footer">
            <span>
              <kbd>Enter</kbd> 执行首项
            </span>
            <span>
              <kbd>Tab</kbd> 切换操作
            </span>
          </div>
        </Modal>
      )}
      {dialog === 'settings' && (
        <Modal
          title="让写作更合你的习惯"
          subtitle="设置保存在本机，即时生效。"
          onClose={() => setDialog(null)}
        >
          <div className="settings-section">
            <h3>外观</h3>
            <div className="theme-options">
              {(
                [
                  { value: 'light', label: '浅色', icon: <Sun size={20} /> },
                  { value: 'dark', label: '深色', icon: <Moon size={20} /> },
                  { value: 'system', label: '跟随系统', icon: <SlidersHorizontal size={20} /> },
                ] as const
              ).map((t) => (
                <button
                  key={t.value}
                  className={settings.theme === t.value ? 'selected' : ''}
                  onClick={() => setSettings((s) => ({ ...s, theme: t.value }))}
                >
                  {t.icon}
                  {t.label}
                  {settings.theme === t.value && <Check size={13} />}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <h3>正文排版</h3>
            <label className="setting-row">
              <span>字号</span>
              <input
                aria-label="正文字号"
                type="range"
                min="13"
                max="24"
                value={settings.fontSize}
                onChange={(e) => setSettings((s) => ({ ...s, fontSize: Number(e.target.value) }))}
              />
              <output>{settings.fontSize}px</output>
            </label>
            <label className="setting-row">
              <span>行高</span>
              <input
                aria-label="正文行高"
                type="range"
                min="1.4"
                max="2.3"
                step="0.1"
                value={settings.lineHeight}
                onChange={(e) => setSettings((s) => ({ ...s, lineHeight: Number(e.target.value) }))}
              />
              <output>{settings.lineHeight.toFixed(1)}</output>
            </label>
            <label className="setting-row">
              <span>正文宽度</span>
              <input
                aria-label="正文宽度"
                type="range"
                min="560"
                max="1100"
                step="20"
                value={settings.width}
                onChange={(e) => setSettings((s) => ({ ...s, width: Number(e.target.value) }))}
              />
              <output>{settings.width}px</output>
            </label>
            <label className="setting-row">
              <span>字体风格</span>
              <select
                value={settings.serif ? 'serif' : 'sans'}
                onChange={(e) => setSettings((s) => ({ ...s, serif: e.target.value === 'serif' }))}
              >
                <option value="sans">清晰黑体</option>
                <option value="serif">书卷宋体</option>
              </select>
            </label>
          </div>
          <div className="settings-section">
            <h3>文件与保存</h3>
            <label className="setting-row">
              <span>
                自动保存<small>停止输入后，保存已有路径的文档</small>
              </span>
              <input
                aria-label="自动保存"
                type="checkbox"
                className="switch"
                checked={settings.autosave}
                onChange={(e) => setSettings((s) => ({ ...s, autosave: e.target.checked }))}
              />
            </label>
            <p className="settings-note">
              新文档先保留为本地草稿。按 Ctrl S 选择位置后，才会写入 Markdown 文件。
            </p>
          </div>
          <div className="modal-footer">
            <button className="text-button" onClick={() => setSettings(defaultSettings)}>
              恢复默认设置
            </button>
            <button className="primary-button" onClick={() => setDialog(null)}>
              完成
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'shortcuts' && (
        <Modal
          title="双手留在键盘上"
          subtitle="也可以通过菜单使用这些操作。"
          onClose={() => setDialog(null)}
        >
          <div className="shortcut-list">
            {[
              ['新建文档', 'Ctrl N'],
              ['打开文件', 'Ctrl O'],
              ['保存文档', 'Ctrl S'],
              ['快速打开', 'Ctrl P'],
              ['命令面板', 'Ctrl K'],
              ['查找与替换', 'Ctrl F'],
              ['全文搜索', 'Ctrl Shift F'],
              ['撤销 / 重做', 'Ctrl Z / Ctrl Shift Z'],
              ['关闭文档', 'Ctrl W'],
              ['显示 / 隐藏侧栏', 'Ctrl \\'],
              ['设置', 'Ctrl ,'],
              ['退出专注模式', 'Esc'],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {dialog === 'conflict' && diskConflict && (
        <Modal
          wide
          title="文件出现了两个版本"
          subtitle="当前编辑内容没有被覆盖。比较后选择要保留的版本。"
          onClose={() => setDialog(null)}
        >
          <div className="conflict-compare">
            <section>
              <h3>当前编辑内容</h3>
              <pre>{docs.find((d) => d.id === diskConflict.documentId)?.content}</pre>
            </section>
            <section>
              <h3>磁盘上的内容</h3>
              <pre>{diskConflict.content}</pre>
            </section>
          </div>
          <div className="modal-footer conflict-footer">
            <button
              onClick={() => {
                patch(diskConflict.documentId, {
                  content: diskConflict.content,
                  version: diskConflict.version,
                  bom: diskConflict.bom,
                  crlf: diskConflict.crlf,
                  saved: diskConflict.content,
                  status: 'clean',
                });
                setDialog(null);
              }}
            >
              采用磁盘版本
            </button>
            <button
              onClick={() => {
                setDialog(null);
                void save(diskConflict.documentId, true);
              }}
            >
              当前内容另存为
            </button>
            <button
              className="primary-button"
              onClick={async () => {
                const id = diskConflict.documentId;
                patch(id, { version: diskConflict.version, status: 'dirty' });
                setDialog(null);
                await save(id);
              }}
            >
              保留当前版本并保存
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'close' && (
        <Modal
          title={closeTarget === 'app' ? '退出前，保留你的文字' : '这篇文档还有未保存的修改'}
          subtitle={
            closeTarget === 'app'
              ? '可以先保存文件，或保留草稿，下次继续。'
              : '保存到文件后再关闭，或明确放弃这次修改。'
          }
          onClose={() => setDialog(null)}
        >
          <div className="close-description">
            <FileText size={25} />
            <span>
              {closeTarget === 'app'
                ? `${docs.filter((d) => d.content !== d.saved).length} 篇文档有未保存修改`
                : docs.find((d) => d.id === closeTarget)?.name}
            </span>
          </div>
          <div className="modal-footer">
            <button onClick={() => setDialog(null)}>取消</button>
            <button onClick={() => void finishClose(true)}>
              {closeTarget === 'app' ? '保留草稿并退出' : '放弃修改'}
            </button>
            <button className="primary-button" onClick={() => void finishClose(false)}>
              {closeTarget === 'app' ? '保存文件并退出' : '保存并关闭'}
            </button>
          </div>
        </Modal>
      )}
      {namePrompt && (
        <Modal
          title={
            namePrompt.type === 'rename'
              ? '重命名文档'
              : namePrompt.type === 'folder'
                ? '新建文件夹'
                : '新建文档'
          }
          subtitle={
            namePrompt.type === 'rename'
              ? '其他文档中的相对链接不会自动修改。'
              : `创建于 ${root || '当前工作区'}`
          }
          onClose={() => setNamePrompt(null)}
        >
          <input
            className="name-input"
            autoFocus
            aria-label="名称"
            placeholder="输入名称…"
            value={namePrompt.value}
            onChange={(e) => setNamePrompt({ ...namePrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && namePrompt.value.trim()) void submitName();
            }}
          />
          <div className="modal-footer">
            <button onClick={() => setNamePrompt(null)}>取消</button>
            <button
              className="primary-button"
              disabled={!namePrompt.value.trim()}
              onClick={() => void submitName()}
            >
              确定
            </button>
          </div>
        </Modal>
      )}
      {mode !== 'read' && !focus && (
        <div className="insert-dock">
          <IconButton title="插入二级标题" onClick={() => insert('\n## ', '', '新标题')}>
            <Heading2 size={16} />
          </IconButton>
          <IconButton
            title="插入表格"
            onClick={() => insert('\n| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n')}
          >
            <Table size={16} />
          </IconButton>
          <IconButton title="插入图片" onClick={chooseImage}>
            <ImageIcon size={16} />
          </IconButton>
          <span />
          <IconButton
            title="撤销"
            onClick={() => {
              if (editor.current) undo(editor.current);
            }}
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            title="重做"
            onClick={() => {
              if (editor.current) redo(editor.current);
            }}
          >
            <Redo2 size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
