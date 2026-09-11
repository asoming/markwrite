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
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { invoke } from '@tauri-apps/api/core';
import Editor, { releaseEditor } from './editor/Editor';
import Reader from './Reader';
import { configureInlineSyntax } from './lib/markdown';
import { useDocumentStats } from './lib/useDocumentStats';
import { loadExtensions, type ExtensionPack } from './lib/extensions';
import { findTable, changeTable, type TableAction } from './editor/table';
import * as platform from './lib/platform';
import { getHeadings, renderMarkdown, hydrateDiagrams, escapeHtml } from './lib/markdown';
import { defaultSettings, readSession, writeSession, flushSession } from './lib/recovery';
import { welcome, syntaxSample } from './lib/sample';
import type { Document, DiskFile, FileEntry, Mode, SearchHit, Settings } from './lib/types';
import katexCss from 'katex/dist/katex.min.css?inline';
import EditingMenu, { type EditingAction } from './components/EditingMenu';
import InsertDialog, { type InsertKind } from './components/InsertDialog';
import {
  applyFormatting,
  insertMarkdownTransaction,
  readTableAtSelection,
  type TableModel,
} from './editor/formatting';
import WorkspacePanel, { type WorkspaceTab } from './components/WorkspacePanel';
import DiffView from './components/DiffView';
import ExtensionsPanel from './components/ExtensionsPanel';
import AiPanel from './components/AiPanel';
import TransferPanel from './components/TransferPanel';
import {
  fileName,
  pathKey,
  readRecents,
  updateRecents,
  wikiTargets,
  relativeDocument,
} from './lib/workspace';

const uid = () => crypto.randomUUID();
const basename = fileName;
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
configureInlineSyntax(loadExtensions());
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [syntaxRevision, setSyntaxRevision] = useState(0);
  const [mode, setMode] = useState<Mode>('live');
  const [sidebar, setSidebar] = useState(true);
  const [sideTab, setSideTab] = useState<'files' | 'outline' | 'search'>('files');
  const [root, setRoot] = useState<string | undefined>(
    platform.desktop ? recovered?.root : undefined,
  );
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('markwrite.workspaces.v1') || '[]');
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, 10) : [];
    } catch {
      return [];
    }
  });
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [focus, setFocus] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState(false);
  const [dialog, setDialog] = useState<
    | 'settings'
    | 'commands'
    | 'quickopen'
    | 'shortcuts'
    | 'conflict'
    | 'close'
    | 'about'
    | 'extensions'
    | 'ai'
    | 'export'
    | 'transfer'
    | null
  >(null);
  const [palette, setPalette] = useState('');
  const [transfer, setTransfer] = useState<{
    kind: 'image' | 'publish';
    html?: string;
    name: string;
    id: string;
    source: string;
    from: number;
    to: number;
  }>();
  const [menu, setMenu] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [recents, setRecents] = useState(readRecents);
  const [insertDialog, setInsertDialog] = useState<{
    kind: InsertKind;
    documentId: string;
    from: number;
    to: number;
    source: string;
    text: string;
    table?: TableModel;
  } | null>(null);
  const [linkChoices, setLinkChoices] = useState<{ path: string; name?: string }[]>([]);
  const aiSelection = useRef<{
    id: string;
    from: number;
    to: number;
    source: string;
    selection: string;
  } | null>(null);
  const [exportFormat, setExportFormat] = useState<'html' | 'pdf' | 'docx'>('html');
  const [exportOptions, setExportOptions] = useState({
    toc: true,
    theme: 'light',
    template: 'standard' as 'standard' | 'academic' | 'compact',
  });

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
  const searchRequest = useRef<string>('');
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
  const { headings, words } = useDocumentStats(current?.content || '', current.id);
  const activeTable = useMemo(
    () =>
      current?.content.length > 300_000 ? null : findTable(current?.content || '', position.line),
    [current?.content, position.line],
  );
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
    if (file.path)
      try {
        setRecents(updateRecents(file.path));
      } catch {
        notify('最近文件列表暂时无法保存。');
      }
    const existing = docsRef.current.find((d) => d.path && pathKey(d.path) === pathKey(file.path));
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
        const recentRoots = [folder.path, ...workspaces.filter((p) => p !== folder.path)].slice(
          0,
          10,
        );
        setWorkspaces(recentRoots);
        try {
          localStorage.setItem('markwrite.workspaces.v1', JSON.stringify(recentRoots));
        } catch {
          /* workspace is still open */
        }
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
    const existing = docsRef.current.find(
      (d) => d.id === path || (d.path && pathKey(d.path) === pathKey(path)),
    );
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
    saving.current.add(d.id);
    patch(d.id, { status: 'saving' });
    try {
      let result =
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
      let migrationConflict: string | undefined;
      if (settingsRef.current.attachmentMode === 'relative' && d.content.includes('data:image/')) {
        try {
          const migrated = await platform.migrateEmbeddedImages(result.path, d.content);
          if (migrated !== d.content)
            result = await platform.writeFile({ ...result, content: migrated });
        } catch (error) {
          if (errorText(error).includes('CONFLICT:')) migrationConflict = errorText(error);
          notify(
            migrationConflict
              ? '附件迁移时磁盘文件被外部修改，当前内容已保留，请比较版本。'
              : `文档已保存，附件迁移未完成：${errorText(error)}。内嵌图片仍保留，保存时会重试。`,
          );
        }
      }
      const persisted = result;
      try {
        setRecents(updateRecents(persisted.path));
      } catch {
        /* document was saved successfully */
      }
      updateDocs((items) =>
        items.map((item) =>
          item.id === d.id
            ? {
                ...item,
                path: persisted.path,
                name: basename(persisted.path),
                version: persisted.version,
                bom: persisted.bom,
                crlf: persisted.crlf,
                content: item.content === d.content ? persisted.content : item.content,
                saved: persisted.content,
                status: migrationConflict
                  ? 'conflict'
                  : item.content === d.content
                    ? 'clean'
                    : 'dirty',
                error: migrationConflict,
              }
            : item,
        ),
      );
      if (root) void refresh();
      return !migrationConflict;
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
    const range = { from: view.state.selection.main.from, to: view.state.selection.main.to };
    const original = view.state.doc.toString();
    if (file.size > 20 * 1024 * 1024) {
      notify('图片超过 20MB，请先压缩。');
      return;
    }
    try {
      const path = await platform.attachImage(
        settingsRef.current.attachmentMode === 'embedded' ? undefined : d.path,
        file,
      );
      if (currentRef.current.id !== d.id || editor.current?.state.doc.toString() !== original) {
        notify('图片已处理，请回到原文档后重新插入。');
        return;
      }
      view.dispatch(
        insertMarkdownTransaction(
          view.state,
          `![${file.name.replace(/[\[\]]/g, '')}](<${path}>)\n`,
          range,
        ),
      );
      view.focus();
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
  async function followLink(href: string, source = currentRef.current) {
    if (/^https?:\/\//.test(href)) {
      try {
        await platform.openExternal(href);
      } catch (e) {
        notify(errorText(e));
      }
      return;
    }
    if (href.startsWith('#wiki:')) {
      try {
        const target = decodeURIComponent(href.slice(6));
        const disk =
          platform.desktop && root
            ? await invoke<DiskFile[]>('workspace_documents', { path: root })
            : [];
        const opened = docsRef.current.map((d) => ({
          path: d.path || d.id,
          content: d.content,
          name: d.name,
        }));
        const candidates = wikiTargets(target, source.path || source.id, [
          ...opened,
          ...disk.filter((d) => !opened.some((o) => o.path === d.path)),
        ]);
        if (candidates.length === 1) {
          await openPath(candidates[0].path);
          const heading = target.split('#')[1];
          if (heading)
            setTimeout(() => {
              const h = getHeadings(currentRef.current.content).find(
                (h) => h.text === heading || h.id === heading,
              );
              if (h) jump(h.line);
            }, 100);
        } else if (candidates.length) setLinkChoices(candidates);
        else notify(`链接目标“${target}”不存在。请创建对应文档，或检查名称和工作文件夹。`);
      } catch (error) {
        notify(errorText(error));
      }
      return;
    }
    if (href.startsWith('#')) return;
    const path = source?.path;
    if (!path || /^[a-z]+:/i.test(href)) {
      notify('请先保存文档，再打开相对链接。');
      return;
    }
    try {
      const decoded = decodeURIComponent(href.split('#')[0]);
      const normalized = path.replace(/\\/g, '/');
      await openPath(`${normalized.slice(0, normalized.lastIndexOf('/'))}/${decoded}`);
    } catch (e) {
      notify(`无法打开链接：${errorText(e)}`);
    }
  }
  async function doExport(format: 'html' | 'pdf' | 'docx' | 'publish' = 'html') {
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
      if (format !== 'html' && format !== 'publish') {
        const { exportDocument } = await import('./lib/export');
        if (await exportDocument(format, node, current.name, { template: exportOptions.template }))
          notify(`${format.toUpperCase()} 已导出`);
        return;
      }
      const unsupported = [...node.querySelectorAll('.math-error,.diagram-error,img[data-asset]')];
      if (unsupported.length) throw new Error('存在未能渲染的公式、图表或图片，请修正后再导出。');
      if (exportOptions.toc) {
        const nav = document.createElement('nav');
        nav.className = 'export-toc';
        nav.innerHTML =
          '<h2>目录</h2>' +
          getHeadings(current.content)
            .map(
              (h) =>
                `<p style="margin-left:${(h.level - 1) * 16}px"><a href="#${h.id}">${escapeHtml(h.text)}</a></p>`,
            )
            .join('');
        node.prepend(nav);
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
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(current.name)}</title><style>body{max-width:800px;margin:60px auto;padding:0 28px;color:#24272e;font:17px/1.85 system-ui,sans-serif}h1,h2,h3{line-height:1.4}h1{font-size:2em}h2{margin-top:2em}a{color:#4361d9}pre{padding:20px;background:#f3f4f6;overflow:auto;border-radius:8px}code{font-family:monospace}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;border:1px solid #e4e7ec;text-align:left}blockquote{border-left:3px solid #4361d9;margin-left:0;padding-left:20px;color:#657080}img,svg{max-width:100%}hr{border:0;border-top:1px solid #e4e7ec;margin:32px 0}${mathCss}${exportOptions.theme === 'dark' ? 'body{background:#20232a;color:#e1e5ec}pre{background:#272c35}a{color:#93a8ff}td,th{border-color:#4b5261}' : ''}${exportOptions.template === 'academic' ? 'body{font-family:serif;max-width:720px}h1{text-align:center}' : exportOptions.template === 'compact' ? 'body{font-size:14px;line-height:1.55;max-width:1000px}' : ''}</style></head><body>${node.outerHTML}</body></html>`;
      if (format === 'publish') {
        const r = editor.current?.state.selection.main;
        setTransfer({
          kind: 'publish',
          html,
          name: current.name,
          id: current.id,
          source: current.content,
          from: r?.from || 0,
          to: r?.to || 0,
        });
        setDialog('transfer');
        return;
      }
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
        const newPath = await renameGuarded(current.path, namePrompt.value);
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
    const update = (event: Event) => {
      configureInlineSyntax((event as CustomEvent<ExtensionPack[]>).detail || loadExtensions());
      setSyntaxRevision((v) => v + 1);
    };
    window.addEventListener('markwrite-extensions-changed', update);
    return () => window.removeEventListener('markwrite-extensions-changed', update);
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
    };
    apply();
    for (const [name, value] of Object.entries(settings.customColors || {}))
      if (/^#[0-9a-f]{6}$/i.test(value))
        document.documentElement.style.setProperty('--' + name, value);
    if (!settings.customColors)
      for (const name of ['paper', 'ink', 'accent'])
        document.documentElement.style.removeProperty('--' + name);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme, settings.customColors]);
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        await flushSession(docsRef.current, activeId, settings, root);
      } catch {
        notify('草稿恢复空间不足。请立即保存到文件，避免丢失当前修改。');
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [docs, activeId, settings, root]);
  useEffect(() => {
    const timer = setInterval(() => {
      void flushSession(docsRef.current, activeId, settings, root).catch(() =>
        notify('草稿恢复副本写入失败，请立即保存文档并检查磁盘空间。'),
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [activeId, settings, root]);
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
    if (!platform.desktop) return;
    let disposed = false;
    const unlisten: (() => void)[] = [];
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const handlers = await Promise.all([
          listen<DiskFile[]>('open-documents', (event) => event.payload.forEach(addDisk)),
          listen<string>('document-open-error', (event) => notify(event.payload)),
          listen('workspace-changed', () => {
            void refresh();
            window.dispatchEvent(new Event('focus'));
          }),
          listen<{ requestId: string; hits: SearchHit[] }>('search-progress', (event) => {
            if (event.payload.requestId === searchRequest.current)
              setHits((old) => [...old, ...event.payload.hits].slice(-500));
          }),
        ]);
        if (disposed) handlers.forEach((fn) => fn());
        else unlisten.push(...handlers);
      })
      .catch((e) => notify(errorText(e)));
    if (root) void invoke('watch_folder', { path: root }).catch((e) => notify(errorText(e)));
    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, [root]);
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
          const latest = docsRef.current.find((item) => item.id === d.id);
          if (latest && latest.status !== 'error' && !saving.current.has(d.id))
            patch(d.id, {
              status: 'error',
              error: '原文件无法访问或已被移动。当前文字已保留，可另存为。',
            });
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
    const requestId = crypto.randomUUID();
    searchRequest.current = requestId;
    if (!query.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const disk = root ? await platform.searchFolder(root, query, requestId) : [];
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
        if (!canceled && searchRequest.current === requestId)
          setHits([...fromBuffers, ...disk.filter((h) => !openedPaths.has(h.path))].slice(0, 500));
      } catch (e) {
        if (!canceled) notify(errorText(e));
      } finally {
        if (!canceled && searchRequest.current === requestId) setSearching(false);
      }
    }, 250);
    return () => {
      canceled = true;
      clearTimeout(timer);
      if (platform.desktop) void invoke('cancel_search', { requestId }).catch(() => {});
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
        const fn = await getCurrentWindow().onCloseRequested(async (event) => {
          if (exitAfterSave.current) return;
          if (saving.current.size) {
            event.preventDefault();
            notify('正在完成文件操作，请稍后再关闭。');
            return;
          }
          if (docsRef.current.some((d) => d.content !== d.saved || d.status === 'conflict')) {
            event.preventDefault();
            setCloseTarget('app');
            setDialog('close');
          } else
            try {
              await flushSession(docsRef.current, activeId, settings, root);
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
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault();
        void save(currentRef.current.id, true);
      } else if (key === 'h') {
        e.preventDefault();
        setMode('source');
        if (editor.current) openSearchPanel(editor.current);
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
    { label: '导出 HTML', hint: '', icon: <Download size={18} />, run: () => openExport('html') },
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
    if (saving.current.size) {
      notify('正在完成文件操作，请稍后再关闭。');
      return;
    }
    if (closeTarget === 'app') {
      if (!keepDraft)
        for (const d of [...docsRef.current]) {
          if (
            (d.content !== d.saved || d.status === 'conflict' || d.status === 'error') &&
            !(await save(d.id))
          )
            return;
          const latest = docsRef.current.find((item) => item.id === d.id);
          if (
            latest &&
            (latest.content !== latest.saved ||
              latest.status === 'conflict' ||
              latest.status === 'error')
          )
            return;
        }
      try {
        await flushSession(docsRef.current, activeId, settings, root);
      } catch {
        notify('草稿保存失败，请先另存文件。');
        return;
      }
      exitAfterSave.current = true;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      try {
        await getCurrentWindow().close();
      } catch (error) {
        exitAfterSave.current = false;
        notify(`无法关闭窗口：${errorText(error)}`);
        return;
      }
    } else if (closeTarget) {
      if (!keepDraft && !(await save(closeTarget))) return;
      const latest = docsRef.current.find((d) => d.id === closeTarget);
      if (
        !keepDraft &&
        latest &&
        (latest.content !== latest.saved ||
          latest.status === 'conflict' ||
          latest.status === 'error')
      )
        return;
      removeDoc(closeTarget);
    }
    setDialog(null);
  }
  function openExport(format: 'html' | 'pdf' | 'docx') {
    setExportFormat(format);
    setMenu(false);
    setDialog('export');
  }
  function replaceCurrent(text: string) {
    const view = editor.current;
    if (!view) return;
    setMode('live');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      userEvent: 'input.restore',
    });
    view.focus();
  }
  function launchInsert(kind: InsertKind) {
    const view = editor.current;
    if (!view) return;
    setMode('live');
    const range = view.state.selection.main;
    const table = kind === 'table' ? readTableAtSelection(view) : null;
    setInsertDialog({
      kind,
      documentId: current.id,
      from: table?.from ?? range.from,
      to: table?.to ?? range.to,
      source: view.state.doc.toString(),
      text: view.state.sliceDoc(range.from, range.to),
      table: table?.table,
    });
  }
  function applyInsert(markdown: string) {
    const view = editor.current,
      target = insertDialog;
    if (!view || !target) return;
    if (current.id !== target.documentId || view.state.doc.toString() !== target.source) {
      notify('原文已改变，请重新选择插入位置。');
      return;
    }
    const text = target.kind === 'table' && !target.table ? '\n\n' + markdown + '\n\n' : markdown;
    view.dispatch(
      insertMarkdownTransaction(view.state, text, { from: target.from, to: target.to }),
    );
    setInsertDialog(null);
    view.focus();
  }
  async function importDroppedFiles(files: File[]) {
    if (platform.desktop) return; // Native drag/drop is authorized and delivered by Rust.
    for (const file of files) {
      if (file.size > 32 * 1024 * 1024) {
        notify(`${file.name} 超过 32MB，未打开。`);
        continue;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        const d = draft(file.name, text.replace(/\r\n/g, '\n'));
        updateDocs((items) => [...items, d]);
        setActiveId(d.id);
      } catch {
        notify(`${file.name} 不是有效 UTF-8 文件。`);
      }
    }
    notify('已作为草稿打开，按 Ctrl S 选择保存位置。');
  }
  async function renameGuarded(path: string, name: string) {
    const affected = docsRef.current
      .filter(
        (d) =>
          d.path &&
          (pathKey(d.path) === pathKey(path) || pathKey(d.path).startsWith(pathKey(path) + '/')),
      )
      .map((d) => d.id);
    if (affected.some((id) => saving.current.has(id)))
      throw new Error('文档正在保存，请稍后再重命名。');
    affected.forEach((id) => saving.current.add(id));
    try {
      const next = await platform.renameFile(path, name);
      handleRenamed(path, next);
      return next;
    } finally {
      affected.forEach((id) => saving.current.delete(id));
    }
  }
  function handleRenamed(from: string, to: string) {
    updateDocs((items) =>
      items.map((d) => {
        if (!d.path) return d;
        const old = d.path.replace(/\\/g, '/'),
          base = from.replace(/\\/g, '/');
        if (pathKey(old) === pathKey(base) || pathKey(old).startsWith(pathKey(base) + '/')) {
          const next = to + old.slice(base.length);
          return { ...d, path: next, name: basename(next) };
        }
        return d;
      }),
    );
    try {
      setRecents(updateRecents(undefined, from));
    } catch {
      /* auxiliary list only */
    }
  }
  function handleTrashed(paths: string[]) {
    updateDocs((items) =>
      items.map((d) =>
        d.path &&
        paths.some(
          (p) => pathKey(d.path!) === pathKey(p) || pathKey(d.path!).startsWith(pathKey(p) + '/'),
        )
          ? { ...d, path: undefined, version: undefined, status: 'dirty', saved: '' }
          : d,
      ),
    );
    try {
      let next = readRecents();
      for (const path of paths) next = updateRecents(undefined, path);
      setRecents(next);
    } catch {
      /* buffers retained */
    }
  }
  function handleMenuAction(action: EditingAction) {
    const view = editor.current;
    if (action.startsWith('format:')) {
      setMode('live');
      if (view) applyFormatting(view, action.slice(7) as Parameters<typeof applyFormatting>[1]);
      return;
    }
    if (action.startsWith('insert:')) {
      launchInsert(action.slice(7) as InsertKind);
      return;
    }
    if (action.startsWith('theme:')) {
      setSettings((s) => ({ ...s, theme: action.slice(6) as Settings['theme'] }));
      return;
    }
    switch (action) {
      case 'app:new':
        newDocument();
        break;
      case 'app:open':
        void openFiles();
        break;
      case 'app:folder':
        void openFolder();
        break;
      case 'app:save':
        void save();
        break;
      case 'app:saveAs':
        void save(current.id, true);
        break;
      case 'app:exportHtml':
        openExport('html');
        break;
      case 'app:exportPdf':
        openExport('pdf');
        break;
      case 'app:exportDocx':
        openExport('docx');
        break;
      case 'app:close':
        requestClose();
        break;
      case 'app:quit':
        if (platform.desktop)
          void import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => getCurrentWindow().close())
            .catch((e) => notify(errorText(e)));
        break;
      case 'app:find':
      case 'app:replace':
        setMode('source');
        if (view) {
          openSearchPanel(view);
          view.focus();
        }
        break;
      case 'app:selectAll':
        if (view) {
          setMode('live');
          selectAll(view);
          view.focus();
        }
        break;
      case 'app:undo':
        if (view) {
          setMode('live');
          undo(view);
        }
        break;
      case 'app:redo':
        if (view) {
          setMode('live');
          redo(view);
        }
        break;
      case 'app:settings':
        setDialog('settings');
        break;
      case 'app:shortcuts':
        setDialog('shortcuts');
        break;
      case 'app:about':
        setDialog('about');
        break;
      case 'app:upload':
        if (view) {
          const r = view.state.selection.main;
          setTransfer({
            kind: 'image',
            name: current.name,
            id: current.id,
            source: current.content,
            from: r.from,
            to: r.to,
          });
          setDialog('transfer');
        }
        break;
      case 'app:publish':
        void doExport('publish');
        break;
      case 'app:extensions':
        setDialog('extensions');
        break;
      case 'app:ai':
        if (view) {
          const r = view.state.selection.main;
          aiSelection.current = {
            id: current.id,
            from: r.from,
            to: r.to,
            source: current.content,
            selection: view.state.sliceDoc(r.from, r.to),
          };
          setDialog('ai');
        }
        break;
      case 'app:quickOpen':
        setPalette('');
        setDialog('quickopen');
        break;
      case 'app:search':
        setSidebar(true);
        setSideTab('search');
        break;
      case 'view:live':
        setMode('live');
        break;
      case 'view:source':
        setMode('source');
        break;
      case 'view:read':
        setMode('read');
        break;
      case 'view:focus':
        setFocus((v) => !v);
        break;
      case 'view:sidebar':
        setSidebar((v) => !v);
        break;
      case 'view:compare':
        setWorkspaceTab(null);
        setCompareId((v) => (v ? null : docs.find((d) => d.id !== current.id)?.id || current.id));
        break;
      case 'view:workspace':
        setWorkspaceTab('files');
        break;
      case 'view:git':
        setWorkspaceTab('git');
        break;
      case 'view:history':
        setWorkspaceTab('history');
        break;
      case 'view:backlinks':
        setWorkspaceTab('backlinks');
        break;
      case 'view:attachments':
        setWorkspaceTab('attachments');
        break;
    }
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
          '--code-font': settings.codeFont || 'monospace',
          '--body-font':
            settings.bodyFont ||
            (settings.serif
              ? '"Noto Serif CJK SC", "Source Han Serif SC", serif'
              : '"Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif'),
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
                    {workspaces.length > 1 && (
                      <select
                        className="workspace-switch"
                        aria-label="切换工作区"
                        value={root}
                        onChange={async (e) => {
                          const next = e.target.value;
                          try {
                            const listing = await platform.listFolder(next);
                            setEntries(listing);
                            setRoot(next);
                          } catch (error) {
                            notify(errorText(error));
                          }
                        }}
                      >
                        {workspaces.map((path) => (
                          <option value={path} key={path}>
                            {basename(path)}
                          </option>
                        ))}
                      </select>
                    )}
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
                {!!recents.length && (
                  <>
                    <div className="section-caption">
                      <span>最近打开</span>
                    </div>
                    {recents.slice(0, 8).map((recent) => (
                      <div className="recent-file" key={recent.path}>
                        <button
                          className="tree-row"
                          title={recent.path}
                          onClick={() => void openPath(recent.path)}
                        >
                          <FileText size={14} />
                          <span>{recent.name}</span>
                        </button>
                        <button
                          className="remove-recent"
                          aria-label={`移除最近记录 ${recent.name}`}
                          onClick={() => {
                            try {
                              setRecents(updateRecents(undefined, recent.path));
                            } catch (e) {
                              notify(errorText(e));
                            }
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </>
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
                  {searching && (
                    <button
                      onClick={() => {
                        searchRequest.current = '';
                        setSearching(false);
                        if (platform.desktop) void invoke('cancel_search', {}).catch(() => {});
                      }}
                    >
                      取消
                    </button>
                  )}
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
          <EditingMenu
            onAction={handleMenuAction}
            mode={mode}
            theme={settings.theme}
            focus={focus}
          />
        )}
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
                      <button disabled={exporting} onClick={() => openExport('html')}>
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
        <div className="document-workspace">
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
              onLink={(href) => void followLink(href)}
              onImage={(file) => void image(file)}
              onMarkdownFiles={(files) => void importDroppedFiles(files)}
              onEditTable={({ from }) => {
                const view = editor.current;
                if (view) {
                  view.dispatch({ selection: { anchor: from } });
                  launchInsert('table');
                }
              }}
              onComposition={(v) => {
                composing.current = v;
              }}
            />
            {mode === 'read' && (
              <Reader
                content={current.content}
                path={current.path}
                theme={settings.theme}
                revision={syntaxRevision}
                onLink={(href) => void followLink(href)}
              />
            )}
            {mode !== 'read' && activeTable && (
              <div className="table-actions" onMouseDown={(e) => e.preventDefault()}>
                <span>表格</span>
                <button onClick={() => launchInsert('table')}>可视化编辑</button>
                <button onClick={() => editTable('addRow')}>添加行</button>
                <button onClick={() => editTable('addColumn')}>添加列</button>
                <button onClick={() => editTable('removeRow')}>删除行</button>
                <button onClick={() => editTable('removeColumn')}>删除列</button>
              </div>
            )}
            {mode !== 'read' && selection && (
              <div className="format-bar" onMouseDown={(e) => e.preventDefault()}>
                <IconButton title="粗体" onClick={() => handleMenuAction('format:bold')}>
                  <Bold size={15} />
                </IconButton>
                <IconButton title="斜体" onClick={() => handleMenuAction('format:italic')}>
                  <Italic size={15} />
                </IconButton>
                <IconButton title="插入链接" onClick={() => launchInsert('link')}>
                  <LinkIcon size={15} />
                </IconButton>
                <IconButton title="行内代码" onClick={() => handleMenuAction('format:inlineCode')}>
                  <Code2 size={15} />
                </IconButton>
                <IconButton title="引用" onClick={() => handleMenuAction('format:quote')}>
                  <Quote size={15} />
                </IconButton>
              </div>
            )}
          </div>
          {compareId && (
            <div className="compare-pane">
              <div className="workspace-title">
                <select
                  aria-label="对照文档"
                  value={compareId}
                  onChange={(e) => setCompareId(e.target.value)}
                >
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button aria-label="关闭并排对照" onClick={() => setCompareId(null)}>
                  <X size={16} />
                </button>
              </div>
              <Reader
                content={(docs.find((d) => d.id === compareId) || current).content}
                path={(docs.find((d) => d.id === compareId) || current).path}
                theme={settings.theme}
                revision={syntaxRevision}
                onLink={(href) =>
                  void followLink(href, docs.find((d) => d.id === compareId) || current)
                }
              />
            </div>
          )}
          {workspaceTab && !focus && (
            <WorkspacePanel
              tab={workspaceTab}
              onTab={setWorkspaceTab}
              root={root}
              current={current}
              docs={docs}
              entries={entries}
              onClose={() => setWorkspaceTab(null)}
              onOpen={(path) => void openPath(path)}
              onRestore={(text) => replaceCurrent(text)}
              onRefresh={() => void refresh()}
              onTrashed={handleTrashed}
              onRename={renameGuarded}
              onNotify={notify}
            />
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
      {insertDialog && (
        <InsertDialog
          kind={insertDialog.kind}
          initialText={insertDialog.text}
          table={insertDialog.table}
          onClose={() => setInsertDialog(null)}
          onInsert={applyInsert}
          onChooseImage={() => {
            setInsertDialog(null);
            chooseImage();
          }}
          documents={docs
            .filter((d) => d.id !== current.id)
            .map((d) => ({
              name: d.name,
              path:
                d.path && current.path
                  ? relativeDocument(current.path, d.path)
                  : '#wiki:' + encodeURIComponent(d.name.replace(/\.(md|markdown)$/i, '')),
            }))}
        />
      )}
      {!!linkChoices.length && (
        <Modal
          title="选择链接目标"
          subtitle="存在同名文档，请选择要打开的文件。"
          onClose={() => setLinkChoices([])}
        >
          {linkChoices.map((d) => (
            <button
              className="panel-list-item"
              key={d.path}
              onClick={() => {
                void openPath(d.path);
                setLinkChoices([]);
              }}
            >
              {d.name || d.path}
              <small>{d.path}</small>
            </button>
          ))}
        </Modal>
      )}
      {dialog === 'transfer' && transfer && (
        <Modal
          title={transfer.kind === 'image' ? '上传图片到图床' : '发布文档'}
          subtitle="连接你自己的服务，明确发送后才会联网"
          onClose={() => setDialog(null)}
        >
          <TransferPanel
            kind={transfer.kind}
            html={transfer.html}
            name={transfer.name}
            onInsert={(url) => {
              const view = editor.current;
              if (!view) return;
              if (current.id !== transfer.id || current.content !== transfer.source) {
                notify('原文已变化，请复制链接后在目标位置插入。');
                return;
              }
              setMode('live');
              view.dispatch(
                insertMarkdownTransaction(view.state, `![图片](<${url}>)`, {
                  from: transfer.from,
                  to: transfer.to,
                }),
              );
              setDialog(null);
            }}
          />
        </Modal>
      )}
      {dialog === 'about' && (
        <Modal
          title="墨页 · Markwrite"
          subtitle="本地优先的 Markdown 写作工具"
          onClose={() => setDialog(null)}
        >
          <p>
            通过菜单设置格式、插入表格和公式，也可以直接使用
            Markdown。源码、编辑与阅读共用同一份正文。
          </p>
          <p>
            本版本提供历史、反向链接、附件管理、Git、PDF 与 Word 导出。扩展使用可检查的文字片段；AI
            仅在你主动选择文字并配置服务后工作。
          </p>
          <p className="panel-note">
            Linux 与 Windows 构建；输入法、显示缩放和长期写作的真机验证记录见项目文档。
          </p>
          <button
            className="primary-button"
            onClick={() => void platform.openExternal('https://github.com/asoming/markwrite')}
          >
            查看项目与更新
          </button>
        </Modal>
      )}
      {dialog === 'extensions' && (
        <Modal
          title="编辑扩展"
          subtitle="管理模板和可复用片段"
          wide
          onClose={() => setDialog(null)}
        >
          <ExtensionsPanel
            onError={notify}
            onInsert={(markdown) => {
              const view = editor.current;
              if (!view) return;
              const selected = view.state.sliceDoc(
                view.state.selection.main.from,
                view.state.selection.main.to,
              );
              setMode('live');
              view.dispatch(
                insertMarkdownTransaction(
                  view.state,
                  markdown.replaceAll('{{selection}}', selected),
                ),
              );
              setDialog(null);
              view.focus();
            }}
          />
        </Modal>
      )}
      {dialog === 'ai' && (
        <Modal
          title="AI 写作助手"
          subtitle="选择文字 → 预览修改 → 接受或舍弃"
          wide
          onClose={() => setDialog(null)}
        >
          <AiPanel
            selection={aiSelection.current?.selection || ''}
            onApply={(text) => {
              const snapshot = aiSelection.current,
                view = editor.current;
              if (!snapshot || !view) return;
              if (current.id !== snapshot.id || current.content !== snapshot.source) {
                notify('原文已变化，请重新选择内容生成建议。');
                return;
              }
              setMode('live');
              view.dispatch(
                insertMarkdownTransaction(view.state, text, {
                  from: snapshot.from,
                  to: snapshot.to,
                }),
              );
              setDialog(null);
              view.focus();
            }}
          />
        </Modal>
      )}
      {dialog === 'export' && (
        <Modal
          title={`导出 ${exportFormat === 'docx' ? 'Word 文档' : exportFormat.toUpperCase()}`}
          subtitle="使用当前编辑内容，无需先覆盖原文档"
          onClose={() => setDialog(null)}
        >
          <div className="settings-extra">
            <label>
              排版模板{' '}
              <select
                value={exportOptions.template}
                onChange={(e) =>
                  setExportOptions((v) => ({ ...v, template: e.target.value as typeof v.template }))
                }
              >
                <option value="standard">标准文档</option>
                <option value="academic">学术阅读</option>
                <option value="compact">紧凑笔记</option>
              </select>
            </label>
            {exportFormat === 'html' && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={exportOptions.toc}
                    onChange={(e) => setExportOptions((v) => ({ ...v, toc: e.target.checked }))}
                  />{' '}
                  包含文档目录
                </label>
                <label>
                  外观{' '}
                  <select
                    value={exportOptions.theme}
                    onChange={(e) => setExportOptions((v) => ({ ...v, theme: e.target.value }))}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </label>
              </>
            )}
            <p className="panel-note">
              本地图片、公式和图表会嵌入导出文件。未加载的网络图片或语法错误会提示处理，不会悄悄丢弃。
            </p>
          </div>
          <div className="modal-actions">
            <button onClick={() => setDialog(null)}>取消</button>
            <button
              className="primary-button"
              disabled={exporting}
              onClick={() => {
                setDialog(null);
                void doExport(exportFormat);
              }}
            >
              选择位置并导出
            </button>
          </div>
        </Modal>
      )}
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
          <div className="settings-section settings-extra">
            <h3>字体与阅读预设</h3>
            <label>
              正文字体{' '}
              <input
                aria-label="正文字体名称"
                placeholder="留空使用系统字体"
                value={settings.bodyFont || ''}
                onChange={(e) => setSettings((v) => ({ ...v, bodyFont: e.target.value }))}
              />
            </label>
            <label>
              代码字体{' '}
              <input
                aria-label="代码字体名称"
                value={settings.codeFont || ''}
                onChange={(e) => setSettings((v) => ({ ...v, codeFont: e.target.value }))}
              />
            </label>
            <div className="snippet-buttons">
              <button
                onClick={() =>
                  setSettings((v) => ({
                    ...v,
                    fontSize: 17,
                    lineHeight: 1.9,
                    width: 760,
                    serif: false,
                  }))
                }
              >
                日常写作
              </button>
              <button
                onClick={() =>
                  setSettings((v) => ({
                    ...v,
                    fontSize: 19,
                    lineHeight: 2,
                    width: 720,
                    serif: true,
                  }))
                }
              >
                长文阅读
              </button>
              <button
                onClick={() =>
                  setSettings((v) => ({
                    ...v,
                    fontSize: 15,
                    lineHeight: 1.6,
                    width: 1000,
                    serif: false,
                  }))
                }
              >
                技术文档
              </button>
            </div>
            <details>
              <summary>自定义主题颜色</summary>
              {(['paper', 'ink', 'accent'] as const).map((key) => (
                <label className="setting-row" key={key}>
                  <span>{{ paper: '背景', ink: '正文', accent: '强调色' }[key]}</span>
                  <input
                    type="color"
                    aria-label={`自定义${key}`}
                    value={
                      settings.customColors?.[key] ||
                      { paper: '#fcfcfd', ink: '#24272e', accent: '#4361d9' }[key]
                    }
                    onChange={(e) =>
                      setSettings((v) => ({
                        ...v,
                        customColors: {
                          paper: '#fcfcfd',
                          ink: '#24272e',
                          accent: '#4361d9',
                          ...v.customColors,
                          [key]: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
              ))}
              <button onClick={() => setSettings((v) => ({ ...v, customColors: undefined }))}>
                恢复主题原色
              </button>
            </details>
          </div>
          <div className="settings-section">
            <h3>文件与保存</h3>
            <label className="setting-row">
              <span>图片保存方式</span>
              <select
                aria-label="图片保存方式"
                value={settings.attachmentMode}
                onChange={(e) =>
                  setSettings((v) => ({
                    ...v,
                    attachmentMode: e.target.value as Settings['attachmentMode'],
                  }))
                }
              >
                <option value="relative">文档旁的 assets 文件夹</option>
                <option value="embedded">内嵌到 Markdown</option>
              </select>
            </label>
            <p className="settings-note">
              目录扫描排除隐藏目录、.git、node_modules、target 和符号链接；搜索最多显示 500
              条匹配，可随时取消。
            </p>
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
          <DiffView
            before={docs.find((d) => d.id === diskConflict.documentId)?.content || ''}
            after={diskConflict.content}
          />
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
          <IconButton title="插入表格" onClick={() => launchInsert('table')}>
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
