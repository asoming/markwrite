import BackupPanel, { BackupScheduler } from './components/BackupPanel';
import { prepareMove, selectedMoveChanges, type PreparedMove } from './lib/referenceMove';
import { movedReferencePath } from './lib/referenceMaintenance';
import { captureBackupSettings, restoreBackupSettings } from './lib/settingsBackup';
import { DocumentThemeStyles } from './components/ThemeManager';
import type { ExportOptions } from './lib/export';
import { invalidateWorkspaceIndex } from './lib/workspaceCache';
import { t, useI18n, setLanguage } from './lib/i18n';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import {
  FileText,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Plus,
  Settings as SettingsIcon,
  ChevronRight,
  X,
  Check,
  Code2,
  Command,
  Focus,
  Moon,
  FilePlus2,
  Download,
  Save,
  ListTree,
  Files,
  AlertCircle,
  RefreshCw,
  Bold,
  Italic,
  Link as LinkIcon,
  Table,
  Image as ImageIcon,
  Quote,
  Heading2,
  Undo2,
  Redo2,
} from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import { EditPermission } from './lib/editPermission';
import { invoke } from '@tauri-apps/api/core';
import Editor, {
  releaseEditor,
  updateStoredEditor,
  undo,
  redo,
  selectAll,
  openSearchPanel,
  scrollIntoView,
  applyFormatting,
  insertMarkdownTransaction,
  readTableAtSelection,
} from './editor/lazyEditor';
import Reader from './Reader';
import type { ReaderHandle } from './lib/readingTypes';
import type { ReadingLocation } from './lib/readingState';
import { configureInlineSyntax, configureMarkdown } from './lib/markdown';
import { useDocumentStats } from './lib/useDocumentStats';
import { loadExtensions, type ExtensionPack } from './lib/extensions';
import { findTable, changeTable, type TableAction } from './editor/table';
import * as platform from './lib/platform';
import { getHeadings, renderMarkdown, hydrateDiagrams, escapeHtml } from './lib/markdown';
import { highlightCodeBlocks } from './lib/codeHighlight';
import codeHighlightCss from './codeHighlight.css?inline';
import { useQuickOpenFiles } from './lib/useQuickOpenFiles';
import { ResponsiveSidebar, useNarrowLayout } from './components/ResponsiveSidebar';
import {
  defaultSettings,
  readSession,
  writeSession,
  flushSession,
  recoveryPending,
  loadDeferredSession,
  finishRecovery,
  mergeRecoveredDocuments,
  initialOpenError,
} from './lib/recovery';
import {
  createWindowCloseHandler,
  flushStableCloseSnapshot,
  hasUnsavedWork,
} from './lib/closeGuard';
import { welcome, syntaxSample } from './lib/sample';
import type { Document, DiskFile, FileEntry, Mode, SearchHit, Settings } from './lib/types';
import katexCss from 'katex/dist/katex.min.css?inline';
import './components/workspace.css';
import EditingMenu, { type EditingAction } from './components/EditingMenu';
import type { InsertKind } from './components/InsertDialog';
import type { TableModel } from './editor/formatting';
import type { WorkspaceTab } from './components/WorkspacePanel';
import FileNavigator from './components/FileNavigator';
import FloatingViewControls from './components/FloatingViewControls';
import { resolveTheme, themeIsDark, themeTypography, themeDefaults } from './lib/themes';
import { defaultMarkdownStatus, requestMarkdownDefault } from './lib/nativeSettings';
import {
  fileName,
  pathKey,
  readRecents,
  updateRecents,
  wikiTargets,
  relativeDocument,
  resolveDocumentLink,
} from './lib/workspace';

const RenameReferencesDialog = lazy(() => import('./components/RenameReferencesDialog'));
const ExportOptionsPanel = lazy(() => import('./components/ExportOptionsPanel'));
const DocumentToolsPanel = lazy(() => import('./components/DocumentToolsPanel'));
const PortablePanel = lazy(() => import('./components/PortablePanel'));
const RichClipboardPanel = lazy(() => import('./components/RichClipboardPanel'));
const InsertDialog = lazy(() => import('./components/InsertDialog'));
const WorkspacePanel = lazy(() => import('./components/WorkspacePanel'));
const DiffView = lazy(() => import('./components/DiffView'));
const ExtensionsPanel = lazy(() => import('./components/ExtensionsPanel'));
const AiPanel = lazy(() => import('./components/AiPanel'));
const TransferPanel = lazy(() => import('./components/TransferPanel'));
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));
const ImportPanel = lazy(() => import('./components/ImportPanel'));

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
setLanguage(recovered?.settings.language || 'zh-CN');
configureMarkdown({ compatibility: recovered?.settings.markdownCompatibility === true });
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
          <IconButton title={t('关闭对话框')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  useI18n();
  const [sessionReady, setSessionReady] = useState(!recoveryPending());
  const [recoveryError, setRecoveryError] = useState('');
  const [openingError, setOpeningError] = useState(initialOpenError);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [docs, setDocs] = useState<Document[]>(initialDocs);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const [activeId, setActiveId] = useState(
    recovered?.active && initialDocs.some((d) => d.id === recovered.active)
      ? recovered.active
      : initialDocs[0].id,
  );
  const [settings, setSettings] = useState<Settings>(recovered?.settings || defaultSettings);
  useEffect(() => setLanguage(settings.language), [settings.language]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [syntaxRevision, setSyntaxRevision] = useState(0);
  const [mode, setModeState] = useState<Mode>('read');
  const editPermission = useRef(new EditPermission());
  const pendingEditorAction = useRef<{ id: string; run: (view: EditorView) => void } | undefined>(
    undefined,
  );
  function setMode(next: Mode) {
    const id = currentRef.current.id;
    editPermission.current.select(id, next);
    if (next === 'read') {
      pendingEditorAction.current = undefined;
      const view = editor.current;
      if (view) {
        const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
        readerLine.current = { id, line: view.state.doc.lineAt(top.from).number };
      }
    } else if (mode === 'read') {
      const point = reader.current?.getLocation();
      if (point) {
        readingPoints.current.set(id, point);
        pendingEditorAction.current = {
          id,
          run: (view) => {
            const target = view.state.doc.line(Math.min(point.line, view.state.doc.lines));
            view.dispatch({
              selection: { anchor: target.from },
              effects: scrollIntoView(target.from, { y: 'start' }),
            });
            view.focus();
          },
        };
      }
    }
    setModeState(next);
  }
  function withEditor(next: 'live' | 'source', run: (view: EditorView) => void) {
    setMode(next);
    if (editor.current) run(editor.current);
    else {
      const restore = pendingEditorAction.current;
      pendingEditorAction.current = {
        id: currentRef.current.id,
        run: (view) => {
          if (restore?.id === currentRef.current.id) restore.run(view);
          run(view);
        },
      };
    }
  }
  const [desktopSidebar, setDesktopSidebar] = useState(true);
  const [overlaySidebar, setOverlaySidebar] = useState(false);
  const [sideTab, setSideTab] = useState<'files' | 'outline' | 'search'>('files');
  const [root, setRoot] = useState<string | undefined>(
    platform.desktop ? recovered?.root : undefined,
  );
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState('');
  const folderRequest = useRef(0);
  const navigationRequest = useRef(0);
  function selectDocument(id: string) {
    setOverlaySidebar(false);
    if (currentRef.current && currentRef.current.id !== id) rememberNavigation();
    navigationRequest.current++;
    setActiveId(id);
    setModeState(editPermission.current.mode(id));
  }
  const [workspaces, setWorkspaces] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('markwrite.workspaces.v1') || '[]');
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, 10) : [];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [focus, setFocus] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState(false);
  const [dialog, setDialog] = useState<
    | 'encoding'
    | 'windows'
    | 'portable'
    | 'clipboard'
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
    | 'import'
    | null
  >(null);
  const [palette, setPalette] = useState('');
  const quickSearch = useQuickOpenFiles(dialog === 'quickopen', root, palette);
  const [transfer, setTransfer] = useState<{
    kind: 'image' | 'publish';
    html?: string;
    name: string;
    id: string;
    source: string;
    from: number;
    to: number;
  }>();
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab | null>(null);
  const [referenceMove, setReferenceMove] = useState<PreparedMove>();
  const [referenceMoveBusy, setReferenceMoveBusy] = useState(false);
  const [referenceMoveError, setReferenceMoveError] = useState('');
  const preparingMove = useRef(false);
  const moveLocks = useRef<string[]>([]);
  const moveCompletion = useRef<
    { resolve: (path: string) => void; reject: (error: unknown) => void } | undefined
  >(undefined);
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
  const [exportOptions, setExportOptions] = useState<ExportOptions & { theme: string }>({
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
  const narrow = useNarrowLayout(sideWidth);
  const sidebar = narrow ? overlaySidebar : desktopSidebar;
  const setSidebar = narrow ? setOverlaySidebar : setDesktopSidebar;
  useEffect(() => {
    setOverlaySidebar(false);
  }, [narrow, dialog]);
  const editor = useRef<EditorView | null>(null);
  const reader = useRef<ReaderHandle | null>(null);
  const pendingReaderAction = useRef<
    { id: string; run: (handle: ReaderHandle) => void } | undefined
  >(undefined);
  function withReader(run: (handle: ReaderHandle) => void) {
    if (mode === 'read' && reader.current) run(reader.current);
    else {
      pendingReaderAction.current = { id: currentRef.current.id, run };
      setMode('read');
    }
  }
  const readerLine = useRef<{ id: string; line: number } | null>(null);
  const readingPoints = useRef(new Map<string, ReadingLocation>());
  const navigation = useRef<{ id: string; location?: ReadingLocation }[]>([]);
  const forwardNavigation = useRef<{ id: string; location?: ReadingLocation }[]>([]);
  const skipNavigation = useRef(false);
  function rememberNavigation() {
    if (skipNavigation.current) return;
    navigation.current.push({
      id: currentRef.current.id,
      location: reader.current?.getLocation() || readingPoints.current.get(currentRef.current.id),
    });
    if (navigation.current.length > 100) navigation.current.shift();
    forwardNavigation.current = [];
  }
  function navigateHistory(direction: -1 | 1) {
    const source = direction < 0 ? navigation.current : forwardNavigation.current;
    const target = source.pop();
    if (!target) return;
    if (!docsRef.current.some((item) => item.id === target.id)) {
      navigateHistory(direction);
      return;
    }
    const destination = direction < 0 ? forwardNavigation.current : navigation.current;
    destination.push({
      id: currentRef.current.id,
      location: reader.current?.getLocation() || undefined,
    });
    if (target.location) readingPoints.current.set(target.id, target.location);
    skipNavigation.current = true;
    selectDocument(target.id);
    skipNavigation.current = false;
    editPermission.current.select(target.id, 'read');
    setModeState('read');
    if (target.id === currentRef.current.id && target.location)
      reader.current?.restoreLocation(target.location);
  }
  async function adjacentFile(direction: -1 | 1) {
    if (!currentRef.current.path) return;
    try {
      const folder = await platform.parentFolder(currentRef.current.path);
      const files = folder?.entries.filter((entry) => !entry.directory) || [];
      const index = files.findIndex(
        (entry) => pathKey(entry.path) === pathKey(currentRef.current.path!),
      );
      const target = files[index + direction];
      if (index >= 0 && target) await openPath(target.path);
    } catch (error) {
      notify(errorText(error));
    }
  }
  async function newWindow(path?: string) {
    if (!platform.desktop) {
      notify(
        t(
          '独立进程窗口请在桌面版使用。',
          'Independent process windows are available in the desktop app.',
        ),
      );
      return;
    }
    try {
      await invoke('new_document_window', { path, settings: settingsRef.current });
      if (path && currentRef.current.content !== currentRef.current.saved)
        notify(
          t(
            '新窗口读取磁盘版本，当前草稿继续保留。',
            'The new window reads the disk version. Your current draft is retained.',
          ),
        );
    } catch (error) {
      notify(errorText(error));
    }
  }
  function openEncoded(file: DiskFile) {
    const existing = docsRef.current.find((item) => item.path === file.path);
    if (existing && existing.content !== existing.saved) {
      const item: Document = { ...draft(basename(file.path), file.content), ...file };
      updateDocs((items) => [...items, item]);
      selectDocument(item.id);
      notify(
        t(
          '原未保存草稿已保留在另一个标签中。',
          'Your unsaved draft is retained in its original tab.',
        ),
      );
    } else addDisk(file);
    const opened = docsRef.current.find(
      (item) => item.path === file.path && item.content === file.content,
    );
    if (opened) editPermission.current.select(opened.id, 'read');
    setModeState('read');
  }
  const saving = useRef(new Set<string>());
  const searchRequest = useRef<string>('');
  const composing = useRef(false);
  const exitAfterSave = useRef<Document[] | null>(null);
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
      mode === 'read' || current?.content.length > 300_000
        ? null
        : findTable(current?.content || '', position.line),
    [current?.content, position.line, mode],
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
    if (!editPermission.current.canEdit(id)) return;
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
        notify(t('最近文件列表暂时无法保存。'));
      }
    const existing = docsRef.current.find((d) => d.path && pathKey(d.path) === pathKey(file.path));
    if (existing) {
      selectDocument(existing.id);
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
    editPermission.current.select(d.id, settingsRef.current.defaultMode);
    updateDocs((items) => [...items, d]);
    selectDocument(d.id);
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
        folderRequest.current++;
        setSettings((value) => ({ ...value, followFileParent: false }));
        setFolderError('');
        setFolderLoading(false);
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
  useEffect(() => {
    const title = `${current.name} — Markwrite`;
    document.title = title;
    if (platform.desktop)
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch(() => {});
  }, [current.name]);
  async function loadParent(path: string) {
    const request = ++folderRequest.current;
    setFolderLoading(true);
    setFolderError('');
    try {
      const folder = await platform.parentFolder(path);
      if (request !== folderRequest.current) return;
      if (folder) {
        setRoot(folder.path);
        setEntries(folder.entries);
      } else
        setFolderError(t('请用“打开文件夹”选择所在目录。', 'Choose the folder with Open folder.'));
    } catch (error) {
      if (request === folderRequest.current) setFolderError(errorText(error));
    } finally {
      if (request === folderRequest.current) setFolderLoading(false);
    }
  }
  async function refresh() {
    if (settingsRef.current.followFileParent && currentRef.current.path) {
      await loadParent(currentRef.current.path);
      return;
    }
    if (!root) return;
    const request = ++folderRequest.current;
    setFolderLoading(true);
    setFolderError('');
    try {
      const nextEntries = await platform.listFolderShallow(root);
      if (request === folderRequest.current) setEntries(nextEntries);
    } catch (error) {
      if (request === folderRequest.current) setFolderError(errorText(error));
    } finally {
      if (request === folderRequest.current) setFolderLoading(false);
    }
  }
  useEffect(() => {
    if (settings.followFileParent && current.path) void loadParent(current.path);
    else {
      setFolderLoading(false);
      setFolderError('');
    }
    return () => {
      folderRequest.current++;
    };
  }, [settings.followFileParent, current.path]);
  async function openPath(path: string, line?: number) {
    setOverlaySidebar(false);
    const request = ++navigationRequest.current;
    const existing = docsRef.current.find(
      (d) => d.id === path || (d.path && pathKey(d.path) === pathKey(path)),
    );
    try {
      if (existing) {
        selectDocument(existing.id);
      } else {
        const file = await platform.readFile(path);
        if (request !== navigationRequest.current) return;
        addDisk(file);
      }
      const selection = navigationRequest.current;
      if (line)
        setTimeout(() => {
          if (selection === navigationRequest.current) jump(line);
        }, 80);
    } catch (e) {
      if (request === navigationRequest.current) notify(errorText(e));
    }
  }
  function newDocument() {
    const d = draft(`未命名 ${docsRef.current.filter((d) => !d.path).length + 1}.md`);
    updateDocs((items) => [...items, d]);
    editPermission.current.select(d.id, 'live');
    selectDocument(d.id);
    pendingEditorAction.current = { id: d.id, run: (view) => view.focus() };
  }
  async function save(
    id = currentRef.current?.id,
    asNew = false,
    intent: 'manual' | 'auto' | 'close' = 'manual',
  ) {
    const d = docsRef.current.find((d) => d.id === id);
    if (!d || saving.current.has(d.id)) return false;
    if (!asNew && intent !== 'close' && !editPermission.current.canEdit(d.id)) {
      if (d.content === d.saved) return true;
      if (intent !== 'auto')
        notify(
          t(
            '阅读模式保留草稿；切换编辑后可保存。',
            'The draft is retained in reading mode. Switch to edit to save.',
          ),
        );
      return false;
    }
    if (!asNew && d.path && d.content === d.saved && d.status === 'clean') return true;
    if (d.status === 'conflict' && !asNew) {
      await showConflict(d);
      return false;
    }
    saving.current.add(d.id);
    patch(d.id, { status: 'saving' });
    try {
      const result =
        !d.path || asNew
          ? await platform.saveAs(d.content, d.name, d)
          : await platform.writeFile({
              path: d.path,
              content: d.content,
              version: d.version || '',
              bom: d.bom,
              crlf: d.crlf,
              encoding: d.encoding,
            });
      if (!result) {
        patch(d.id, { status: d.content === d.saved ? 'clean' : 'dirty' });
        return false;
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
                encoding: persisted.encoding || d.encoding,
                content: item.content === d.content ? persisted.content : item.content,
                saved: persisted.content,
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
      const disk = await platform.readFile(d.path, d.encoding);
      selectDocument(d.id);
      setDiskConflict({ ...disk, documentId: d.id });
      setDialog('conflict');
    } catch (e) {
      notify(t('{0} 可使用“另存为”保留当前内容。', undefined, [errorText(e)]));
    }
  }
  function removeDoc(id: string) {
    const next = docsRef.current.filter((d) => d.id !== id);
    releaseEditor(id);
    editPermission.current.forget(id);
    if (!next.length) next.push(draft('未命名.md'));
    updateDocs(() => next);
    if (activeId === id) selectDocument(next[Math.max(0, next.length - 1)].id);
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
    if (editPermission.current.mode(currentRef.current.id) === 'read') {
      if (reader.current) reader.current.jumpToLine(line);
      else readerLine.current = { id: currentRef.current.id, line };
      return;
    }
    const view = editor.current;
    if (!view) return;
    const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: scrollIntoView(target.from, { y: 'start', yMargin: 44 }),
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
    if (!d || !view || !editPermission.current.canEdit(d.id)) return;
    const range = { from: view.state.selection.main.from, to: view.state.selection.main.to };
    const original = view.state.doc.toString();
    if (file.size > 20 * 1024 * 1024) {
      notify(t('图片超过 20MB，请先压缩。'));
      return;
    }
    try {
      const path = await platform.attachImage(
        settingsRef.current.attachmentMode === 'embedded' ? undefined : d.path,
        file,
      );
      if (currentRef.current.id !== d.id || editor.current?.state.doc.toString() !== original) {
        notify(t('图片已处理，请回到原文档后重新插入。'));
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
      notify(t('至少保留一列、一行正文；表头不能作为正文行删除。'));
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
        else
          notify(
            t('链接目标“{0}”不存在。请创建对应文档，或检查名称和工作文件夹。', undefined, [target]),
          );
      } catch (error) {
        notify(errorText(error));
      }
      return;
    }
    if (href.startsWith('#')) return;
    try {
      const target = resolveDocumentLink(source?.path, href);
      await openPath(target.path);
      if (target.fragment)
        setTimeout(() => {
          const selected = currentRef.current;
          if (!selected.path || pathKey(selected.path) !== pathKey(target.path)) return;
          const heading = getHeadings(selected.content).find(
            (h) => h.id === target.fragment || h.text === target.fragment,
          );
          if (heading) jump(heading.line);
        }, 100);
    } catch (e) {
      notify(t('无法打开链接：{0}', undefined, [errorText(e)]));
    }
  }
  async function prepareExportArticle() {
    const node = document.createElement('article');
    node.className = 'markdown-body';
    node.innerHTML = renderMarkdown(current.content);
    await hydrateDiagrams(node);
    await highlightCodeBlocks(node);
    for (const img of node.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
      if (!current.path) throw new Error(t('图片路径无法解析，请先保存文档或打开所在文件夹。'));
      img.src = await platform.assetData(current.path, img.dataset.asset!);
      img.removeAttribute('data-asset');
      img.classList.remove('pending-image');
    }
    return node;
  }
  async function doExport(format: 'html' | 'pdf' | 'docx' | 'publish' = 'html') {
    if (!current || exporting) return;
    setExporting(true);
    try {
      const node = await prepareExportArticle();
      if (format !== 'html' && format !== 'publish') {
        const { exportDocument } = await import('./lib/export');
        if (
          await exportDocument(format, node, current.name, {
            ...exportOptions,
            language: settings.language,
          })
        )
          notify(t('{0} 已导出', undefined, [format.toUpperCase()]));
        return;
      }
      const unsupported = [...node.querySelectorAll('.math-error,.diagram-error,img[data-asset]')];
      if (unsupported.length)
        throw new Error(t('存在未能渲染的公式、图表或图片，请修正后再导出。'));
      if (exportOptions.toc) {
        const nav = document.createElement('nav');
        nav.className = 'export-toc';
        nav.innerHTML =
          '<h2>' +
          t('目录', 'Contents') +
          '</h2>' +
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
          if (!response.ok) throw new Error(t('无法嵌入公式字体。'));
          const blob = await response.blob();
          const data = await new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.readAsDataURL(blob);
          });
          mathCss = mathCss.split(url).join(data);
        }
      }
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(current.name)}</title><style>body{max-width:800px;margin:60px auto;padding:0 28px;color:#24272e;font:17px/1.85 system-ui,sans-serif}h1,h2,h3{line-height:1.4}h1{font-size:2em}h2{margin-top:2em}a{color:#4361d9}pre{padding:20px;background:#f3f4f6;overflow:auto;border-radius:8px}code{font-family:monospace}table{border-collapse:collapse;width:100%}td,th{padding:10px 14px;border:1px solid #e4e7ec;text-align:left}blockquote{border-left:3px solid #4361d9;margin-left:0;padding-left:20px;color:#657080}img,svg{max-width:100%}hr{border:0;border-top:1px solid #e4e7ec;margin:32px 0}${mathCss}${codeHighlightCss}${exportOptions.theme === 'dark' ? 'body{background:#20232a;color:#e1e5ec}pre{background:#272c35}a{color:#93a8ff}td,th{border-color:#4b5261}' : ''}${exportOptions.template === 'academic' ? 'body{font-family:serif;max-width:720px}h1{text-align:center}' : exportOptions.template === 'compact' ? 'body{font-size:14px;line-height:1.55;max-width:1000px}' : ''}</style></head><body data-theme="${exportOptions.theme === 'dark' ? 'dark' : 'light'}">${node.outerHTML}</body></html>`;
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
        notify(t('HTML 已导出，可离线查看'));
    } catch (e) {
      if (!canceled(e)) notify(t('导出未完成：{0}', undefined, [errorText(e)]));
    } finally {
      setExporting(false);
    }
  }
  async function submitName() {
    if (!namePrompt) return;
    if (saving.current.has(current.id)) {
      notify(t('文档正在保存，请稍后再重命名。'));
      return;
    }
    try {
      if (namePrompt.type === 'rename' && current.path) {
        setNamePrompt(null);
        await renameGuarded(current.path, namePrompt.value);
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
      if (!canceled(e)) notify(errorText(e));
    }
  }
  useEffect(() => {
    configureMarkdown({ compatibility: settings.markdownCompatibility === true });
    setSyntaxRevision((value) => value + 1);
  }, [settings.markdownCompatibility]);
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
      document.documentElement.dataset.theme = resolveTheme(settings.theme, media.matches);
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
    if (!sessionReady) return;
    const timer = setTimeout(async () => {
      try {
        await flushSession(docsRef.current, activeId, settings, root);
      } catch {
        notify(t('草稿恢复空间不足。请立即保存到文件，避免丢失当前修改。'));
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [docs, activeId, settings, root, sessionReady]);
  useEffect(() => {
    if (!sessionReady) return;
    const timer = setInterval(() => {
      void flushSession(docsRef.current, activeId, settings, root).catch(() =>
        notify(t('草稿恢复副本写入失败，请立即保存文档并检查磁盘空间。')),
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [activeId, settings, root, sessionReady]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!recoveryPending()) return;
    let canceled = false;
    let started = false;
    const restore = async () => {
      if (started) return;
      started = true;
      try {
        const previous = await loadDeferredSession();
        if (canceled) return;
        if (previous) {
          updateDocs((items) => mergeRecoveredDocuments(items, previous.docs));
          // An upgrade may not yet have a compact preference snapshot.
          if (!localStorage.getItem('markwrite.preferences.v1')) setSettings(previous.settings);
        }
        finishRecovery();
        setSessionReady(true);
        setRecoveryError('');
      } catch (error) {
        if (!canceled) setRecoveryError(errorText(error));
      }
    };
    window.addEventListener('markwrite-reader-ready', restore, { once: true });
    const timer = setTimeout(restore, 1500);
    return () => {
      canceled = true;
      clearTimeout(timer);
      window.removeEventListener('markwrite-reader-ready', restore);
    };
  }, [recoveryAttempt]);
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
            invalidateWorkspaceIndex();
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
        if (editPermission.current.canAutosave(d) && Date.now() - d.updated > 800)
          void save(d.id, false, 'auto');
    }, 400);
    return () => clearInterval(timer);
  }, [settings.autosave]);
  useEffect(() => {
    let checking = false,
      stopped = false;
    const stamps = new Map<string, string>();
    const check = async (full = false) => {
      if (checking || composing.current) return;
      checking = true;
      for (const d of full ? [...docsRef.current] : [currentRef.current]) {
        if (!d.path || saving.current.has(d.id) || d.status === 'conflict') continue;
        try {
          if (platform.desktop && !full) {
            const stamp = await invoke<string>('document_stamp', { path: d.path });
            if (stamps.get(d.path) === stamp) continue;
            stamps.set(d.path, stamp);
          }
          const file = await platform.readFile(d.path, d.encoding);
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
            patch(d.id, { status: 'conflict', error: t('磁盘文件已修改，请比较版本。') });
          else patch(d.id, { ...file, saved: file.content, status: 'clean' });
        } catch {
          const latest = docsRef.current.find((item) => item.id === d.id);
          if (latest && latest.status !== 'error' && !saving.current.has(d.id))
            patch(d.id, {
              status: 'error',
              error: t('原文件无法访问或已被移动。当前文字已保留，可另存为。'),
            });
        }
      }
      checking = false;
    };
    const timer = setInterval(() => {
      void check();
    }, 2200);
    const focused = () => void check(true);
    window.addEventListener('focus', focused);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', focused);
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
        const fn = await getCurrentWindow().onCloseRequested(
          createWindowCloseHandler({
            documents: () => docsRef.current,
            saving: () =>
              saving.current.size > 0 || (recoveryPending() && hasUnsavedWork(docsRef.current)),
            authorization: exitAfterSave,
            flush: (snapshot) =>
              recoveryPending() && !hasUnsavedWork(snapshot)
                ? Promise.resolve()
                : flushSession(snapshot, activeId, settings, root),
            onBusy: () => notify(t('正在完成文件操作，请稍后再关闭。')),
            onUnsaved: () => {
              setCloseTarget('app');
              setDialog('close');
            },
            onChanged: () => notify(t('关闭期间文档发生了变化，已保留窗口，请再次关闭。')),
            onError: () => notify(t('无法保存会话，请先另存文档。')),
          }),
        );
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
      if (e.isComposing || dialog || insertDialog || namePrompt || referenceMove) return;
      if (e.key === 'F3' && mode === 'read') {
        e.preventDefault();
        reader.current?.findNext(e.shiftKey ? -1 : 1);
        return;
      }
      if (
        mode === 'read' &&
        e.altKey &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      ) {
        e.preventDefault();
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
          navigateHistory(e.key === 'ArrowLeft' ? -1 : 1);
        else void adjacentFile(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (e.key === 'Escape') {
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
        withEditor('source', (view) => openSearchPanel(view));
      } else if (key === 's') {
        e.preventDefault();
        actions.current.save();
      } else if (key === 'o') {
        e.preventDefault();
        actions.current.open();
      } else if (key === 'n' && e.shiftKey) {
        e.preventDefault();
        void newWindow();
      } else if (key === 'd' && mode === 'read') {
        e.preventDefault();
        reader.current?.toggleBookmark();
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
        reader.current?.openSearch();
      } else if (key === '\\') {
        e.preventDefault();
        setSidebar((v) => !v);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [dialog, mode, insertDialog, namePrompt, referenceMove]);
  const commands = [
    { label: t('新建文档'), hint: 'Ctrl N', icon: <FilePlus2 size={18} />, run: newDocument },
    {
      label: t('打开 Markdown 文件'),
      hint: 'Ctrl O',
      icon: <FileText size={18} />,
      run: () => void openFiles(),
    },
    {
      label: t('打开文件夹'),
      hint: '',
      icon: <FolderOpen size={18} />,
      run: () => void openFolder(),
    },
    { label: t('保存文档'), hint: 'Ctrl S', icon: <Save size={18} />, run: () => void save() },
    {
      label: t('另存为…'),
      hint: '',
      icon: <Save size={18} />,
      run: () => void save(current.id, true),
    },
    {
      label: t('导出 HTML'),
      hint: '',
      icon: <Download size={18} />,
      run: () => openExport('html'),
    },
    {
      label: t('查找与替换'),
      hint: 'Ctrl F',
      icon: <Search size={18} />,
      run: () => {
        withEditor('source', (view) => openSearchPanel(view));
      },
    },
    {
      label: focus ? t('退出专注模式') : t('进入专注模式'),
      hint: '',
      icon: <Focus size={18} />,
      run: () => setFocus((v) => !v),
    },
    {
      label: t('切换浅色 / 深色主题'),
      hint: '',
      icon: <Moon size={18} />,
      run: () =>
        setSettings((s) => ({
          ...s,
          theme: themeIsDark(s.theme, matchMedia('(prefers-color-scheme: dark)').matches)
            ? 'light'
            : 'dark',
          customColors: undefined,
        })),
    },
    {
      label: t('设置'),
      hint: 'Ctrl ,',
      icon: <SettingsIcon size={18} />,
      run: () => setTimeout(() => setDialog('settings'), 0),
    },
  ];
  const allFiles = (nodes: FileEntry[]): FileEntry[] =>
    nodes.flatMap((n) => (n.directory ? allFiles(n.children || []) : [n]));
  const quickFiles = [
    ...new Map(
      [
        ...docs.map((d) => ({ name: d.name, path: d.path || d.id, id: d.id })),
        ...allFiles(entries).map((e) => ({ name: e.name, path: e.path, id: '' })),
        ...quickSearch.files.map((e) => ({ ...e, id: '' })),
      ]
        .filter((e) => e.name.toLowerCase().includes(palette.toLowerCase()))
        .reverse()
        .map((e) => [pathKey(e.path), e]),
    ).values(),
  ]
    .reverse()
    .slice(0, 500);
  async function finishClose(keepDraft: boolean) {
    if (saving.current.size || recoveryPending()) {
      notify(t('正在完成文件操作，请稍后再关闭。'));
      return;
    }
    if (closeTarget === 'app') {
      if (!keepDraft)
        for (const d of [...docsRef.current]) {
          if (
            (d.content !== d.saved || d.status === 'conflict' || d.status === 'error') &&
            !(await save(d.id, false, 'close'))
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
      let windowToClose;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        windowToClose = getCurrentWindow();
      } catch (error) {
        notify(t('无法准备关闭窗口：{0}', undefined, [errorText(error)]));
        return;
      }
      let snapshot: Document[] | null;
      try {
        snapshot = await flushStableCloseSnapshot({
          documents: () => docsRef.current,
          saving: () => saving.current.size > 0 || recoveryPending(),
          flush: (documents) => flushSession(documents, activeId, settings, root),
        });
      } catch {
        notify(t('草稿保存失败，请先另存文件。'));
        return;
      }
      if (!snapshot || (!keepDraft && hasUnsavedWork(snapshot))) {
        notify(t('关闭期间文档发生了变化，已保留窗口，请再次关闭。'));
        return;
      }
      // Preserve the explicit keep-draft choice only for the snapshot just persisted.
      // A later native close event revalidates it after the close IPC completes.
      exitAfterSave.current = snapshot;
      setDialog(null);
      try {
        await windowToClose.close();
      } catch (error) {
        exitAfterSave.current = null;
        notify(t('无法关闭窗口：{0}', undefined, [errorText(error)]));
      }
      // Do not clear a fresh unsaved-work dialog opened by that native event.
      return;
    } else if (closeTarget) {
      if (!keepDraft && !(await save(closeTarget, false, 'close'))) return;
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
    setDialog('export');
  }
  function replaceCurrent(text: string) {
    withEditor('live', (view) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        userEvent: 'input.restore',
      });
      view.focus();
    });
  }
  function launchInsert(kind: InsertKind) {
    withEditor('live', (view) => {
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
    });
  }
  function applyInsert(markdown: string) {
    const view = editor.current,
      target = insertDialog;
    if (!view || !target) return;
    if (current.id !== target.documentId || view.state.doc.toString() !== target.source) {
      notify(t('原文已改变，请重新选择插入位置。'));
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
        notify(t('{0} 超过 32MB，未打开。', undefined, [file.name]));
        continue;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        const d = draft(file.name, text.replace(/\r\n/g, '\n'));
        updateDocs((items) => [...items, d]);
        selectDocument(d.id);
      } catch {
        notify(t('{0} 不是有效 UTF-8 文件。', undefined, [file.name]));
      }
    }
    notify(t('已作为草稿打开，按 Ctrl S 选择保存位置。'));
  }
  async function renameGuarded(path: string, name: string) {
    if (!name.trim() || /[/\\\0]/.test(name) || name === '.' || name === '..')
      throw new Error(t('名称不能包含路径分隔符。', 'The name cannot contain path separators.'));
    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return reviewMove(path, path.slice(0, separator + 1) + name.trim());
  }
  async function reviewMove(from: string, to: string) {
    if (!platform.desktop)
      throw new Error(t('请在桌面版移动文件。', 'Move files in the desktop application.'));
    if (from === to) return from;
    if (moveCompletion.current || preparingMove.current)
      throw new Error(t('请先完成当前文件操作。', 'Finish the current file operation first.'));
    if (saving.current.size) throw new Error(t('文档正在保存，请稍后再重命名。'));
    setReferenceMoveError('');
    notify(t('正在后台检查受影响的链接…', 'Checking affected links in the background…'));
    preparingMove.current = true;
    let plan: PreparedMove;
    try {
      const documents = root
        ? await invoke<{ path: string; content: string; name?: string }[]>('workspace_documents', {
            path: root,
          })
        : [];
      plan = await prepareMove(from, to, documents, docsRef.current, platform.readFile);
      if (saving.current.size) throw new Error(t('文档正在保存，请稍后再重命名。'));
      selectedMoveChanges(
        plan,
        plan.changes.map((change) => change.path),
        docsRef.current,
      );
      moveLocks.current = docsRef.current
        .filter(
          (doc) =>
            doc.path &&
            (movedReferencePath(doc.path, from, to) !== doc.path ||
              plan.changes.some((change) => pathKey(change.path) === pathKey(doc.path!))),
        )
        .map((doc) => doc.id);
      moveLocks.current.forEach((id) => saving.current.add(id));
    } finally {
      preparingMove.current = false;
    }
    return new Promise<string>((resolve, reject) => {
      moveCompletion.current = { resolve, reject };
      setReferenceMove(plan);
    });
  }
  function cancelMove() {
    if (referenceMoveBusy) return;
    const completion = moveCompletion.current;
    moveCompletion.current = undefined;
    moveLocks.current.forEach((id) => saving.current.delete(id));
    moveLocks.current = [];
    setReferenceMove(undefined);
    completion?.reject(new DOMException('Canceled', 'AbortError'));
  }
  async function confirmMove(selected: string[]) {
    if (!referenceMove || referenceMoveBusy) return;
    const plan = referenceMove;
    const affected = docsRef.current.filter(
      (doc) =>
        doc.path &&
        (movedReferencePath(doc.path, plan.from, plan.to) !== doc.path ||
          selected.some((path) => pathKey(path) === pathKey(doc.path!))),
    );
    if (affected.some((doc) => saving.current.has(doc.id) && !moveLocks.current.includes(doc.id))) {
      setReferenceMoveError(t('文档正在保存，请稍后再重命名。'));
      return;
    }
    setReferenceMoveBusy(true);
    setReferenceMoveError('');
    affected.forEach((doc) => saving.current.add(doc.id));
    try {
      const changes = selectedMoveChanges(plan, selected, docsRef.current);
      const result = await invoke<{ path: string; files: DiskFile[]; warnings: string[] }>(
        'apply_reference_changes',
        { root: root || null, from: plan.from, to: plan.to, changes },
      );
      for (const file of result.files) {
        const doc = docsRef.current.find(
          (item) =>
            item.path &&
            pathKey(movedReferencePath(item.path, plan.from, plan.to)) === pathKey(file.path),
        );
        if (!doc) continue;
        if (doc.id === currentRef.current.id && editor.current) {
          const view = editor.current;
          if (view.state.doc.toString() !== file.content)
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: file.content },
              userEvent: 'input.references',
            });
        } else updateStoredEditor(doc.id, file.content);
        patch(doc.id, {
          ...file,
          name: basename(file.path),
          saved: file.content,
          status: 'clean',
          error: undefined,
          updated: Date.now(),
        });
      }
      handleRenamed(plan.from, result.path);
      invalidateWorkspaceIndex();
      const nextRoot = root && movedReferencePath(root, plan.from, plan.to);
      if (nextRoot && nextRoot !== root) {
        const request = ++folderRequest.current;
        setRoot(nextRoot);
        void platform
          .listFolder(nextRoot)
          .then((entries) => {
            if (request === folderRequest.current) setEntries(entries);
          })
          .catch((error) => {
            if (request === folderRequest.current) setFolderError(errorText(error));
          });
      } else void refresh();
      const completion = moveCompletion.current;
      moveCompletion.current = undefined;
      moveLocks.current.forEach((id) => saving.current.delete(id));
      moveLocks.current = [];
      setReferenceMove(undefined);
      completion?.resolve(result.path);
      notify(
        result.warnings.length
          ? result.warnings.join('\n')
          : t('文件已移动，已保存 {0} 份引用文档。', 'File moved; saved {0} reference documents.', [
              result.files.length,
            ]),
      );
    } catch (error) {
      setReferenceMoveError(errorText(error));
    } finally {
      affected.forEach((doc) => {
        if (!moveLocks.current.includes(doc.id)) saving.current.delete(doc.id);
      });
      setReferenceMoveBusy(false);
    }
  }
  async function moveCurrent() {
    const path = currentRef.current.path;
    if (!path) {
      notify(t('请先保存文档。', 'Save the document first.'));
      return;
    }
    try {
      const to = await invoke<string | null>('choose_move_destination', { path });
      if (to) await reviewMove(path, to);
    } catch (error) {
      if (!canceled(error)) notify(errorText(error));
    }
  }
  function handleRenamed(from: string, to: string) {
    updateDocs((items) =>
      items.map((d) => {
        if (!d.path) return d;
        const next = movedReferencePath(d.path, from, to);
        if (next !== d.path) {
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
      withEditor('live', (view) =>
        applyFormatting(view, action.slice(7) as Parameters<typeof applyFormatting>[1]),
      );
      return;
    }
    if (action.startsWith('insert:')) {
      launchInsert(action.slice(7) as InsertKind);
      return;
    }
    if (action.startsWith('theme:')) {
      const theme = action.slice(6) as Settings['theme'];
      setSettings((s) => ({
        ...s,
        theme,
        ...themeDefaults(theme),
        customColors: undefined,
      }));
      return;
    }
    switch (action) {
      case 'app:newWindow':
        void newWindow();
        break;
      case 'app:openWindow':
        if (current.path) void newWindow(current.path);
        else
          notify(
            t(
              '请先保存草稿，再在独立窗口打开。',
              'Save this draft before opening it in an independent window.',
            ),
          );
        break;
      case 'app:windows':
        setDialog('windows');
        break;
      case 'app:encoding':
        setDialog('encoding');
        break;
      case 'app:portable':
        setDialog('portable');
        break;
      case 'app:clipboard':
        setDialog('clipboard');
        break;
      case 'view:back':
        navigateHistory(-1);
        break;
      case 'view:forward':
        navigateHistory(1);
        break;
      case 'view:previousFile':
        void adjacentFile(-1);
        break;
      case 'view:nextFile':
        void adjacentFile(1);
        break;
      case 'view:bookmark':
        withReader((handle) => handle.toggleBookmark());
        break;
      case 'view:bookmarks':
        withReader((handle) => handle.openBookmarks());
        break;
      case 'app:new':
        newDocument();
        break;
      case 'app:open':
        void openFiles();
        break;
      case 'app:import':
        setDialog('import');
        break;
      case 'app:folder':
        void openFolder();
        break;
      case 'app:rename':
        setNamePrompt({ type: 'rename', value: current.name });
        break;
      case 'app:move':
        void moveCurrent();
        break;
      case 'app:print':
        openExport('pdf');
        break;
      case 'app:reference': {
        const existing = docsRef.current.find((item) => item.name === 'Markdown 语法手册.md');
        if (existing) selectDocument(existing.id);
        else {
          const item = draft('Markdown 语法手册.md', syntaxSample);
          updateDocs((items) => [...items, item]);
          selectDocument(item.id);
        }
        setMode('read');
        break;
      }
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
        if (mode === 'read') reader.current?.openSearch();
        else if (view) openSearchPanel(view);
        break;
      case 'app:replace':
        withEditor('source', (view) => {
          openSearchPanel(view);
          view.focus();
        });
        break;
      case 'app:selectAll':
        if (mode === 'read') reader.current?.selectAll();
        else if (view) {
          selectAll(view);
          view.focus();
        }
        break;
      case 'app:undo':
        withEditor('live', (view) => undo(view));
        break;
      case 'app:redo':
        withEditor('live', (view) => redo(view));
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
        withEditor('live', (view) => {
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
        });
        break;
      case 'app:publish':
        void doExport('publish');
        break;
      case 'app:extensions':
        setDialog('extensions');
        break;
      case 'app:ai':
        withEditor('live', (view) => {
          const r = view.state.selection.main;
          aiSelection.current = {
            id: current.id,
            from: r.from,
            to: r.to,
            source: current.content,
            selection: view.state.sliceDoc(r.from, r.to),
          };
          setDialog('ai');
        });
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
  const typography = themeTypography(settings.theme);
  return (
    <div
      className={`app ${focus ? 'focus-mode' : ''} ${!sidebar ? 'sidebar-collapsed' : ''}`}
      style={
        {
          '--sidebar-width': `${sideWidth}px`,
          '--editor-size': `${settings.fontSize}px`,
          '--editor-line': settings.lineHeight,
          '--content-width': `${settings.width}px`,
          '--code-font': settings.codeFont || typography.codeFont,
          '--body-font':
            settings.bodyFont ||
            (settings.serif === typography.serif
              ? typography.bodyFont
              : settings.serif
                ? '"Noto Serif CJK SC", "Source Han Serif SC", serif'
                : '"Noto Sans CJK SC", "Source Han Sans SC", system-ui, sans-serif'),
        } as CSSProperties
      }
    >
      <DocumentThemeStyles />
      <BackupScheduler
        root={root}
        language={settings.language}
        getBundle={() => captureBackupSettings(settingsRef.current)}
        onNotify={(message) => notify(message)}
      />
      {sidebar && !focus && (
        <ResponsiveSidebar overlay={narrow} onDismiss={() => setOverlaySidebar(false)}>
          <div className="sidebar-header">
            <span className="sidebar-brand">
              <strong lang="zh-CN">墨页</strong>
              <span lang="en">Markwrite</span>
            </span>
            <IconButton
              title={t('搜索文档')}
              onClick={() => {
                setPalette('');
                setDialog('quickopen');
              }}
            >
              <Search size={15} />
            </IconButton>
            <IconButton title={t('收起侧栏')} onClick={() => setSidebar(false)}>
              <PanelLeftClose size={16} />
            </IconButton>
          </div>
          <div className="sidebar-navigation">
            <button
              className={sideTab === 'files' ? 'active' : ''}
              onClick={() => setSideTab('files')}
            >
              <Files size={15} />
              {t('文档')}
            </button>
            <button
              className={sideTab === 'outline' ? 'active' : ''}
              onClick={() => setSideTab('outline')}
            >
              <ListTree size={15} />
              {t('大纲')}
            </button>
            <IconButton
              title={t('全文搜索 · Ctrl Shift F')}
              active={sideTab === 'search'}
              onClick={() => setSideTab('search')}
            >
              <Search size={16} />
            </IconButton>
          </div>
          <div className="sidebar-content">
            {sideTab === 'files' && (
              <FileNavigator
                root={root}
                entries={entries}
                current={current}
                drafts={docs.filter((item) => !item.path)}
                recents={recents}
                following={settings.followFileParent}
                loading={folderLoading}
                error={folderError}
                onFollow={(followFileParent) =>
                  setSettings((value) => ({ ...value, followFileParent }))
                }
                onFolder={() => void openFolder()}
                onRefresh={() => void refresh()}
                onOpen={(path) => void openPath(path)}
                onDraft={selectDocument}
                onNewFile={() =>
                  root ? setNamePrompt({ type: 'file', value: '' }) : newDocument()
                }
                onNewFolder={() => setNamePrompt({ type: 'folder', value: '' })}
                onRemoveRecent={(path) => {
                  try {
                    setRecents(updateRecents(undefined, path));
                  } catch (error) {
                    notify(errorText(error));
                  }
                }}
              />
            )}
            {sideTab === 'outline' && (
              <>
                <div className="section-caption">
                  <span>{t('文档结构')}</span>
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
                    {t('用 # 写下第一个标题，')}
                    <br />
                    {t('大纲就会出现在这里。')}
                  </p>
                )}
              </>
            )}
            {sideTab === 'search' && (
              <>
                <div className="section-caption">
                  <span>{t('搜索内容')}</span>
                  <span>{searching ? t('搜索中…') : t('{0} 条', undefined, [hits.length])}</span>
                  {searching && (
                    <button
                      onClick={() => {
                        searchRequest.current = '';
                        setSearching(false);
                        if (platform.desktop) void invoke('cancel_search', {}).catch(() => {});
                      }}
                    >
                      {t('取消')}
                    </button>
                  )}
                </div>
                <div className="tree-filter search-input">
                  <Search size={14} />
                  <input
                    autoFocus
                    placeholder={t('在文档中搜索…')}
                    aria-label={t('全文搜索关键词')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button aria-label={t('清除搜索')} onClick={() => setQuery('')}>
                      <X size={12} />
                    </button>
                  )}
                </div>
                <p className="search-scope">
                  {root ? t('当前文件夹与打开的文档') : t('当前打开的文档')}
                </p>
                {hits.map((hit, i) => (
                  <button
                    key={`${hit.path}-${hit.line}-${i}`}
                    className="search-hit"
                    onClick={() => {
                      const d = docs.find((d) => d.id === hit.path || d.path === hit.path);
                      if (d) {
                        selectDocument(d.id);
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
                    {t('没有找到匹配内容。')}
                    <br />
                    {t('试试更短的关键词。')}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="sidebar-bottom">
            <button onClick={() => setDialog('settings')}>
              <SettingsIcon size={16} />
              <span>{t('设置')}</span>
              <kbd>Ctrl ,</kbd>
            </button>
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
        </ResponsiveSidebar>
      )}
      <main className="main" inert={narrow && sidebar && !focus ? true : undefined}>
        {!focus && (
          <header className="compact-header">
            {!sidebar && (
              <IconButton title={t('展开侧栏')} onClick={() => setSidebar(true)}>
                <PanelLeftOpen size={16} />
              </IconButton>
            )}
            <EditingMenu
              onAction={handleMenuAction}
              mode={mode}
              theme={settings.theme}
              focus={focus}
            />
          </header>
        )}
        {docs.length > 1 && !focus && (
          <div className="tabs">
            {docs.map((d) => (
              <div key={d.id} className={`tab ${d.id === current.id ? 'active' : ''}`}>
                <button onClick={() => selectDocument(d.id)}>
                  <FileText size={13} />
                  <span>{d.name}</span>
                  {d.content !== d.saved && <i className="dirty-dot" />}
                </button>
                <IconButton
                  title={t('关闭 {0}', undefined, [d.name])}
                  onClick={() => requestClose(d.id)}
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
            <IconButton title={t('新建文档')} onClick={newDocument}>
              <Plus size={15} />
            </IconButton>
          </div>
        )}
        {openingError && (
          <div className="document-alert" role="alert">
            <span>
              {t('指定文件未能打开：', 'The requested file could not be opened: ')}
              {openingError}
            </span>
            <button
              onClick={() => {
                setOpeningError('');
                setDialog('encoding');
              }}
            >
              {t('选择编码打开…', 'Open with encoding…')}
            </button>
            <button onClick={() => setOpeningError('')}>{t('关闭', 'Close')}</button>
          </div>
        )}
        {recoveryError && (
          <div className="document-alert" role="alert">
            <span>
              {t(
                '旧会话读取失败，原恢复副本已保留：',
                'Previous session could not be read; its recovery copy is preserved: ',
              )}
              {recoveryError}
            </span>
            <button onClick={() => setRecoveryAttempt((n) => n + 1)}>{t('重试', 'Retry')}</button>
          </div>
        )}
        {(current.status === 'conflict' || current.status === 'error') && (
          <div className="document-alert">
            <AlertCircle size={16} />
            <span>
              {current.status === 'conflict'
                ? t('磁盘上的文件发生了变化，自动保存已暂停。')
                : current.error || t('保存失败，当前内容已保留。')}
            </span>
            <button
              onClick={() => (current.status === 'conflict' ? void showConflict() : void save())}
            >
              {current.status === 'conflict' ? t('比较版本') : t('重试保存')}
            </button>
            <button onClick={() => void save(current.id, true)}>{t('另存为')}</button>
          </div>
        )}
        {current.content.length > 300_000 && mode === 'live' && (
          <div className="performance-note">
            {t('当前文档较大，已暂停即时渲染以保证编辑响应。仍可使用源码和阅读模式。')}
          </div>
        )}
        <div className="document-workspace">
          <div className="document-surface" data-custom-document-theme="">
            {mode !== 'read' && (
              <Suspense
                fallback={
                  <p className="navigator-note">{t('正在打开编辑器…', 'Opening editor…')}</p>
                }
              >
                <Editor
                  id={current.id}
                  content={current.content}
                  path={current.path}
                  mode={mode}
                  onChange={(text) => contentChanged(current.id, text)}
                  onReady={(v) => {
                    editor.current = v;
                    const pending = pendingEditorAction.current;
                    if (v && pending?.id === current.id) {
                      pendingEditorAction.current = undefined;
                      pending.run(v);
                    }
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
              </Suspense>
            )}
            {mode === 'read' && (
              <Reader
                ref={reader}
                documentKey={current.id}
                onReady={(handle) => {
                  reader.current = handle;
                  if (!handle) return;
                  const pending = pendingReaderAction.current;
                  if (pending?.id === current.id) {
                    pendingReaderAction.current = undefined;
                    pending.run(handle);
                  }
                  const target = readerLine.current;
                  if (target?.id === current.id) {
                    readerLine.current = null;
                    handle.jumpToLine(target.line);
                  } else {
                    const point = readingPoints.current.get(current.id);
                    if (point) handle.restoreLocation(point);
                  }
                }}
                onNavigate={rememberNavigation}
                onLocationChange={(point) => {
                  readingPoints.current.set(current.id, point);
                  setPosition((old) =>
                    old.line === point.line && old.column === 1
                      ? old
                      : { line: point.line, column: 1 },
                  );
                }}
                parseOptions={{ compatibility: settings.markdownCompatibility === true }}
                content={current.content}
                path={current.path}
                theme={settings.theme}
                revision={syntaxRevision}
                onLink={(href) => void followLink(href)}
              />
            )}
            {mode !== 'read' && activeTable && (
              <div className="table-actions" onMouseDown={(e) => e.preventDefault()}>
                <span>{t('表格')}</span>
                <button onClick={() => launchInsert('table')}>{t('可视化编辑')}</button>
                <button onClick={() => editTable('addRow')}>{t('添加行')}</button>
                <button onClick={() => editTable('addColumn')}>{t('添加列')}</button>
                <button onClick={() => editTable('removeRow')}>{t('删除行')}</button>
                <button onClick={() => editTable('removeColumn')}>{t('删除列')}</button>
              </div>
            )}
            {mode !== 'read' && selection && (
              <div className="format-bar" onMouseDown={(e) => e.preventDefault()}>
                <IconButton title={t('粗体')} onClick={() => handleMenuAction('format:bold')}>
                  <Bold size={15} />
                </IconButton>
                <IconButton title={t('斜体')} onClick={() => handleMenuAction('format:italic')}>
                  <Italic size={15} />
                </IconButton>
                <IconButton title={t('插入链接')} onClick={() => launchInsert('link')}>
                  <LinkIcon size={15} />
                </IconButton>
                <IconButton
                  title={t('行内代码')}
                  onClick={() => handleMenuAction('format:inlineCode')}
                >
                  <Code2 size={15} />
                </IconButton>
                <IconButton title={t('引用')} onClick={() => handleMenuAction('format:quote')}>
                  <Quote size={15} />
                </IconButton>
              </div>
            )}
          </div>
          {compareId && (
            <div className="compare-pane">
              <div className="workspace-title">
                <select
                  aria-label={t('对照文档')}
                  value={compareId}
                  onChange={(e) => setCompareId(e.target.value)}
                >
                  {docs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <button aria-label={t('关闭并排对照')} onClick={() => setCompareId(null)}>
                  <X size={16} />
                </button>
              </div>
              <Reader
                documentKey={`compare:${compareId}`}
                parseOptions={{ compatibility: settings.markdownCompatibility === true }}
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
            <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
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
            </Suspense>
          )}
        </div>
        <FloatingViewControls
          mode={mode}
          onMode={setMode}
          focus={focus}
          onFocus={() => setFocus((value) => !value)}
          transparency={settings.floatingToolbarTransparency}
        />
        {!focus && (
          <footer className="statusbar">
            <button
              className={`save-state ${current.status}`}
              onClick={() => void save()}
              title={current.path || t('选择位置保存为 Markdown 文件')}
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
                  clean: current.path ? t('已保存') : t('草稿已暂存'),
                  dirty: t('未保存'),
                  saving: t('保存中…'),
                  error: t('保存失败'),
                  conflict: t('文件冲突'),
                }[current.status]
              }
            </button>
            <div className="status-right">
              <span>
                {words.toLocaleString()} {' ' + t('字')}
              </span>
              <i />
              <span>
                {t('行') + ' '}
                {position.line}
                {t('，列') + ' '}
                {position.column}
              </span>
              <i />
              <span>
                {(current.encoding || 'utf-8').toUpperCase()}
                {current.bom ? ' BOM' : ''}
              </span>
              <span>{current.crlf ? 'CRLF' : 'LF'}</span>
              <button title={t('排版设置')} onClick={() => setDialog('settings')}>
                {settings.fontSize}px
              </button>
              <IconButton
                title={t('打开命令面板 · Ctrl K')}
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
        <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
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
        </Suspense>
      )}
      {!!linkChoices.length && (
        <Modal
          title={t('选择链接目标')}
          subtitle={t('存在同名文档，请选择要打开的文件。')}
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
          title={transfer.kind === 'image' ? t('上传图片到图床') : t('发布文档')}
          subtitle={t('连接你自己的服务，明确发送后才会联网')}
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <TransferPanel
              kind={transfer.kind}
              html={transfer.html}
              name={transfer.name}
              onInsert={(url) => {
                const view = editor.current;
                if (!view) return;
                if (current.id !== transfer.id || current.content !== transfer.source) {
                  notify(t('原文已变化，请复制链接后在目标位置插入。'));
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
          </Suspense>
        </Modal>
      )}
      {dialog === 'about' && (
        <Modal
          title="Markwrite"
          subtitle="本地 Markdown 编辑与阅读工具 · Local Markdown editor and reader"
          onClose={() => setDialog(null)}
        >
          <div className="about-introduction">
            <p lang="zh-CN">
              通过菜单设置格式、插入表格和公式，也可以直接使用
              Markdown。编辑、源码与阅读共用同一份正文。文件保存在本机，支持 Linux 和 Windows。
            </p>
            <p lang="en">
              Write with visual formatting, tables, and formulas, or edit Markdown directly.
              Editing, source, and reading modes share one document. Your files stay on your device,
              on Linux and Windows.
            </p>
            <p lang="zh-CN">
              内置文件树、历史记录、反向链接、附件管理、Git，以及 HTML、PDF 和 Word 导出。
            </p>
            <p lang="en">
              Includes a file tree, document history, backlinks, attachments, Git, and HTML, PDF,
              and Word export.
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() => void platform.openExternal('https://github.com/asoming/markwrite')}
          >
            {t('查看项目与更新')}
          </button>
        </Modal>
      )}
      {dialog === 'extensions' && (
        <Modal
          title={t('编辑扩展')}
          subtitle={t('管理模板和可复用片段')}
          wide
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <ExtensionsPanel
              onError={notify}
              onInsert={(markdown) => {
                withEditor('live', (view) => {
                  const selected = view.state.sliceDoc(
                    view.state.selection.main.from,
                    view.state.selection.main.to,
                  );
                  view.dispatch(
                    insertMarkdownTransaction(
                      view.state,
                      markdown.replaceAll('{{selection}}', selected),
                    ),
                  );
                  setDialog(null);
                  view.focus();
                });
              }}
            />
          </Suspense>
        </Modal>
      )}
      {dialog === 'ai' && (
        <Modal
          title={t('AI 写作助手')}
          subtitle={t('选择文字 → 预览修改 → 接受或舍弃')}
          wide
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <AiPanel
              selection={aiSelection.current?.selection || ''}
              onApply={(text) => {
                const snapshot = aiSelection.current,
                  view = editor.current;
                if (!snapshot || !view) return;
                if (current.id !== snapshot.id || current.content !== snapshot.source) {
                  notify(t('原文已变化，请重新选择内容生成建议。'));
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
          </Suspense>
        </Modal>
      )}
      {dialog === 'export' && (
        <Modal
          wide
          title={t('导出 {0}', undefined, [
            exportFormat === 'docx' ? t('Word 文档') : exportFormat.toUpperCase(),
          ])}
          subtitle={t('使用当前编辑内容，无需先覆盖原文档')}
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <ExportOptionsPanel
              format={exportFormat}
              value={exportOptions}
              onChange={(next) => setExportOptions({ ...next, theme: next.theme || 'light' })}
              title={current.name}
              language={settings.language}
              prepareArticle={prepareExportArticle}
              sourceKey={current.content}
              busy={exporting}
            />
          </Suspense>
          <div className="modal-footer">
            <button onClick={() => setDialog(null)}>{t('取消')}</button>
            <button
              className="primary-button"
              disabled={exporting}
              onClick={() => {
                setDialog(null);
                void doExport(exportFormat);
              }}
            >
              {t('选择位置并导出')}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label={t('关闭提示')} onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {(dialog === 'commands' || dialog === 'quickopen') && (
        <Modal
          title={dialog === 'commands' ? t('想做些什么？') : t('跳转到文档')}
          subtitle={
            dialog === 'commands' ? t('所有操作，都在这里。') : t('搜索已打开的文档和工作文件夹。')
          }
          onClose={() => setDialog(null)}
        >
          <div className="palette-search">
            <Search size={19} />
            <input
              autoFocus
              aria-label={dialog === 'commands' ? t('搜索操作') : t('搜索文件')}
              placeholder={dialog === 'commands' ? t('搜索操作…') : t('输入文件名…')}
              value={palette}
              onChange={(e) => setPalette(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (dialog === 'commands') commands.find((c) => c.label.includes(palette))?.run();
                  else {
                    const f = quickFiles[0];
                    if (f) {
                      if (f.id) selectDocument(f.id);
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
                      if (f.id) selectDocument(f.id);
                      else void openPath(f.path);
                    }}
                  >
                    <FileText size={17} />
                    <span>
                      {f.name}
                      <small>{f.id ? t('已打开') : f.path}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
            {dialog === 'quickopen' && quickSearch.pending && (
              <p role="status">{t('正在查找子目录…', 'Searching subfolders…')}</p>
            )}
            {dialog === 'quickopen' && quickSearch.error && <p role="alert">{quickSearch.error}</p>}
            {dialog === 'quickopen' && quickFiles.length === 500 && (
              <p>
                {t(
                  '显示前 500 项，请输入更完整的文件名。',
                  'Showing 500 results. Refine the filename to find more.',
                )}
              </p>
            )}
            {dialog === 'quickopen' &&
              !quickSearch.pending &&
              !quickSearch.error &&
              !quickFiles.length && (
                <p className="empty-results">{t('没有找到文档，试试其他关键词。')}</p>
              )}
          </div>
          <div className="palette-footer">
            <span>
              <kbd>Enter</kbd> {' ' + t('执行首项')}
            </span>
            <span>
              <kbd>Tab</kbd> {' ' + t('切换操作')}
            </span>
          </div>
        </Modal>
      )}
      {dialog === 'settings' && (
        <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            onClose={() => setDialog(null)}
            filesExtra={
              <BackupPanel
                language={settings.language}
                root={root}
                getBundle={() => captureBackupSettings(settingsRef.current)}
                onRestored={async (result) => {
                  const restoredEntries = await platform.listFolder(result.path);
                  const preferences = result.settingsBundle
                    ? restoreBackupSettings(result.settingsBundle)
                    : settingsRef.current;
                  folderRequest.current++;
                  setSettings({ ...preferences, followFileParent: false });
                  setRoot(result.path);
                  setEntries(restoredEntries);
                  setFolderError('');
                  setFolderLoading(false);
                  setWorkspaces((old) => {
                    const next = [result.path, ...old.filter((path) => path !== result.path)].slice(
                      0,
                      10,
                    );
                    try {
                      localStorage.setItem('markwrite.workspaces.v1', JSON.stringify(next));
                    } catch {
                      /* restored folder remains open */
                    }
                    return next;
                  });
                  invalidateWorkspaceIndex();
                }}
              />
            }
            defaultAppAvailable={platform.desktop}
            onCheckDefaultApp={async () => (await defaultMarkdownStatus()).isDefault}
            onDefaultApp={async () => {
              const result = await requestMarkdownDefault();
              if (result.platform === 'windows') return { status: 'settings-opened' };
              if (result.isDefault) return { status: 'set' };
              throw new Error(result.message);
            }}
          />
        </Suspense>
      )}
      {dialog === 'portable' && (
        <Modal
          title={t('文档与附件打包', 'Package document and attachments')}
          wide
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <PortablePanel current={current} onClose={() => setDialog(null)} onNotify={notify} />
          </Suspense>
        </Modal>
      )}
      {(dialog === 'encoding' || dialog === 'windows') && (
        <Suspense fallback={null}>
          <DocumentToolsPanel
            kind={dialog}
            current={current}
            onOpen={openEncoded}
            onClose={() => setDialog(null)}
          />
        </Suspense>
      )}
      {dialog === 'clipboard' && (
        <Modal
          title={t('复制到公众号 / 飞书', 'Copy for WeChat / Feishu')}
          wide
          onClose={() => setDialog(null)}
        >
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <RichClipboardPanel
              title={current.name}
              language={settings.language}
              sourceKey={`${current.id}:${current.updated}`}
              prepareArticle={prepareExportArticle}
              onClose={() => setDialog(null)}
            />
          </Suspense>
        </Modal>
      )}
      {dialog === 'import' && (
        <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
          <ImportPanel
            onClose={() => setDialog(null)}
            onImport={(imported) => {
              const added = imported.map((item) => ({
                ...draft(item.name, item.content),
                saved: '',
                status: 'dirty' as const,
              }));
              if (added.length) {
                updateDocs((items) => [...items, ...added]);
                selectDocument(added[0].id);
                setMode(settingsRef.current.defaultMode);
                notify(
                  t('已导入 {0} 个 Markdown 草稿', 'Imported {0} Markdown drafts', [added.length]),
                );
              }
              setDialog(null);
            }}
          />
        </Suspense>
      )}
      {dialog === 'shortcuts' && (
        <Modal
          title={t('双手留在键盘上')}
          subtitle={t('也可以通过菜单使用这些操作。')}
          onClose={() => setDialog(null)}
        >
          <div className="shortcut-list">
            {[
              [t('新建文档'), 'Ctrl N'],
              [t('打开文件'), 'Ctrl O'],
              [t('保存文档'), 'Ctrl S'],
              [t('快速打开'), 'Ctrl P'],
              [t('命令面板'), 'Ctrl K'],
              [t('查找与替换'), 'Ctrl F'],
              [t('全文搜索'), 'Ctrl Shift F'],
              [t('撤销 / 重做'), 'Ctrl Z / Ctrl Shift Z'],
              [t('关闭文档'), 'Ctrl W'],
              [t('显示 / 隐藏侧栏'), 'Ctrl \\'],
              [t('设置'), 'Ctrl ,'],
              [t('退出专注模式'), 'Esc'],
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
          title={t('文件出现了两个版本')}
          subtitle={t('当前编辑内容没有被覆盖。比较后选择要保留的版本。')}
          onClose={() => setDialog(null)}
        >
          <div className="conflict-compare">
            <section>
              <h3>{t('当前编辑内容')}</h3>
              <pre>{docs.find((d) => d.id === diskConflict.documentId)?.content}</pre>
            </section>
            <section>
              <h3>{t('磁盘上的内容')}</h3>
              <pre>{diskConflict.content}</pre>
            </section>
          </div>
          <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
            <DiffView
              before={docs.find((d) => d.id === diskConflict.documentId)?.content || ''}
              after={diskConflict.content}
            />
          </Suspense>
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
              {t('采用磁盘版本')}
            </button>
            <button
              onClick={() => {
                setDialog(null);
                void save(diskConflict.documentId, true);
              }}
            >
              {t('当前内容另存为')}
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
              {t('保留当前版本并保存')}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'close' && (
        <Modal
          title={closeTarget === 'app' ? t('退出前，保留你的文字') : t('这篇文档还有未保存的修改')}
          subtitle={
            closeTarget === 'app'
              ? t('可以先保存文件，或保留草稿，下次继续。')
              : t('保存到文件后再关闭，或明确放弃这次修改。')
          }
          onClose={() => setDialog(null)}
        >
          <div className="close-description">
            <FileText size={25} />
            <span>
              {closeTarget === 'app'
                ? t('{0} 篇文档有未保存修改', undefined, [
                    docs.filter((d) => d.content !== d.saved).length,
                  ])
                : docs.find((d) => d.id === closeTarget)?.name}
            </span>
          </div>
          <div className="modal-footer">
            <button onClick={() => setDialog(null)}>{t('取消')}</button>
            <button onClick={() => void finishClose(true)}>
              {closeTarget === 'app' ? t('保留草稿并退出') : t('放弃修改')}
            </button>
            <button className="primary-button" onClick={() => void finishClose(false)}>
              {closeTarget === 'app' ? t('保存文件并退出') : t('保存并关闭')}
            </button>
          </div>
        </Modal>
      )}
      {referenceMove && (
        <Suspense fallback={<p role="status">{t('正在加载…', 'Loading…')}</p>}>
          <RenameReferencesDialog
            {...referenceMove}
            busy={referenceMoveBusy}
            error={referenceMoveError}
            onConfirm={(paths) => void confirmMove(paths)}
            onCancel={cancelMove}
          />
        </Suspense>
      )}
      {namePrompt && (
        <Modal
          title={
            namePrompt.type === 'rename'
              ? t('重命名文档')
              : namePrompt.type === 'folder'
                ? t('新建文件夹')
                : t('新建文档')
          }
          subtitle={
            namePrompt.type === 'rename'
              ? t(
                  '下一步可预览并选择需要更新的引用。',
                  'Next, review and select the references to update.',
                )
              : t('创建于 {0}', undefined, [root || t('当前工作区')])
          }
          onClose={() => setNamePrompt(null)}
        >
          <input
            className="name-input"
            autoFocus
            aria-label={t('名称')}
            placeholder={t('输入名称…')}
            value={namePrompt.value}
            onChange={(e) => setNamePrompt({ ...namePrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && namePrompt.value.trim()) void submitName();
            }}
          />
          <div className="modal-footer">
            <button onClick={() => setNamePrompt(null)}>{t('取消')}</button>
            <button
              className="primary-button"
              disabled={!namePrompt.value.trim()}
              onClick={() => void submitName()}
            >
              {t('确定')}
            </button>
          </div>
        </Modal>
      )}
      {mode !== 'read' && !focus && (
        <div className="insert-dock">
          <IconButton title={t('插入二级标题')} onClick={() => insert('\n## ', '', '新标题')}>
            <Heading2 size={16} />
          </IconButton>
          <IconButton title={t('插入表格')} onClick={() => launchInsert('table')}>
            <Table size={16} />
          </IconButton>
          <IconButton title={t('插入图片')} onClick={chooseImage}>
            <ImageIcon size={16} />
          </IconButton>
          <span />
          <IconButton
            title={t('撤销')}
            onClick={() => {
              if (editor.current) undo(editor.current);
            }}
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            title={t('重做')}
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
