import { t, useI18n } from '../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RefreshCw, FolderOpen, FileText, Trash2 } from 'lucide-react';
import type { DiskFile, Document, FileEntry } from '../lib/types';
import { desktop } from '../lib/platform';
import { fileName, type IndexedDocument } from '../lib/workspace';
import { useReferenceIndex } from '../lib/useReferenceIndex';
import { workspaceDocuments, invalidateWorkspaceIndex } from '../lib/workspaceCache';
import DiffView from './DiffView';
import LinkGraph from './LinkGraph';
import './workspace.css';

export type WorkspaceTab =
  'history' | 'backlinks' | 'tags' | 'attachments' | 'git' | 'files' | 'graph';
type HistoryEntry = { id: string; createdAt: number; size: number };
type Attachment = { path: string; size: number; references: string[] };
type GitState = {
  branch: string;
  entries: { path: string; index: string; worktree: string }[];
  available: boolean;
  repository: boolean;
};
type Props = {
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  root?: string;
  current: Document;
  docs: Document[];
  entries: FileEntry[];
  onClose: () => void;
  onOpen: (path: string) => void;
  onRestore: (content: string) => void;
  onRefresh: () => void;
  onTrashed: (paths: string[]) => void;
  onRename: (from: string, name: string) => Promise<string>;
  onNotify: (text: string) => void;
};
const labels: Record<WorkspaceTab, string> = {
  graph: '关联视图',
  history: '版本历史',
  backlinks: '反向链接',
  tags: '标签',
  attachments: '附件',
  git: 'Git',
  files: '文件管理',
};
const error = (e: unknown) => (e instanceof Error ? e.message : String(e));
export default function WorkspacePanel(p: Props) {
  const { language } = useI18n();
  const [loading, setLoading] = useState(false),
    [problem, setProblem] = useState('');
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]),
    [selectedHistory, setSelectedHistory] = useState<DiskFile>();
  const [index, setIndex] = useState<IndexedDocument[]>([]),
    [attachments, setAttachments] = useState<Attachment[]>([]);
  const [git, setGit] = useState<GitState>(),
    [gitDiff, setGitDiff] = useState(''),
    [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string[]>([]),
    [confirmTrash, setConfirmTrash] = useState(false);
  const [filter, setFilter] = useState(''),
    [rename, setRename] = useState<{ path: string; name: string }>();
  const scope = `${p.tab}\0${p.root || ''}\0${p.current.id}\0${p.current.path || ''}\0${revision}`;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const actionSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    actionSequence.current++;
    setHistory([]);
    setGit(undefined);
    setGitDiff('');
    setAttachments([]);
    setRename(undefined);
    setSelected([]);
    setSelectedHistory(undefined);
    setConfirmTrash(false);
    setProblem('');
    setLoading(true);
    const fetchData = async () => {
      if (p.tab === 'history') {
        if (desktop && p.current.path) {
          const result = await invoke<HistoryEntry[]>('history_list', { path: p.current.path });
          if (!disposed) setHistory(result);
        } else setHistory([]);
      } else if (p.tab === 'git') {
        if (desktop && p.root) {
          const result = await invoke<GitState>('git_status', { path: p.root });
          if (!disposed) setGit(result);
        }
      } else if (p.tab === 'attachments') {
        if (desktop && p.root) {
          const result = await invoke<Attachment[]>('attachment_inventory', { path: p.root });
          if (!disposed) setAttachments(result);
        } else setAttachments([]);
      }
    };
    void fetchData()
      .catch((e) => !disposed && setProblem(error(e)))
      .finally(() => !disposed && setLoading(false));
    return () => {
      disposed = true;
    };
  }, [p.tab, p.root, p.current.id, p.current.path, revision]);
  const allFiles = useMemo(() => {
    const walk = (entries: FileEntry[]): FileEntry[] =>
      entries.flatMap((e) => [e, ...(e.children ? walk(e.children) : [])]);
    return walk(p.entries);
  }, [p.entries]);
  const indexTab = p.tab === 'backlinks' || p.tab === 'tags' || p.tab === 'graph';
  const [indexEpoch, setIndexEpoch] = useState(0);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState('');
  const [limit, setLimit] = useState(100);
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const [tagLimits, setTagLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    setLimit(100);
  }, [p.tab, filter, p.root]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const invalidated = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIndexEpoch((v) => v + 1), 250);
    };
    window.addEventListener('markwrite-index-invalidated', invalidated);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('markwrite-index-invalidated', invalidated);
    };
  }, []);
  useEffect(() => {
    if (!indexTab) return;
    let cancelled = false;
    setIndexLoading(true);
    setIndexError('');
    const request = desktop && p.root ? workspaceDocuments(p.root) : Promise.resolve([]);
    void request
      .then((files) => {
        if (!cancelled) setIndex(files);
      })
      .catch((e) => {
        if (!cancelled) setIndexError(error(e));
      })
      .finally(() => {
        if (!cancelled) setIndexLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [indexTab, p.root, revision, indexEpoch]);
  useEffect(() => {
    setIndex([]);
    setOpenTags(new Set());
    setTagLimits({});
    setMessage('');
  }, [p.root]);
  const buffers = useMemo(
    () => p.docs.map((d) => ({ path: d.path || d.id, content: d.content, name: d.name })),
    [p.docs],
  );
  const indexed = useReferenceIndex(index, buffers, p.current.path || p.current.id, indexTab);
  const tags = indexed.result.tags;
  const incoming = indexed.result.incoming;
  const waiting = loading || (indexTab && (indexLoading || indexed.pending));
  const toggle = (path: string) =>
    setSelected((old) => (old.includes(path) ? old.filter((x) => x !== path) : [...old, path]));
  async function run(action: (isCurrent: () => boolean) => Promise<void>) {
    const request = ++actionSequence.current;
    const isCurrent = () =>
      mounted.current && latestScope.current === scope && request === actionSequence.current;
    setProblem('');
    setLoading(true);
    try {
      await action(isCurrent);
    } catch (e) {
      if (isCurrent() && !(e instanceof DOMException && e.name === 'AbortError'))
        setProblem(error(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }
  const isReferenced = (asset: Attachment) =>
    asset.references.length > 0 ||
    p.docs.some((d) => {
      try {
        return decodeURIComponent(d.content).includes(fileName(asset.path));
      } catch {
        return d.content.includes(fileName(asset.path));
      }
    });
  async function trash() {
    if (
      p.tab === 'attachments' &&
      attachments.some((a) => selected.includes(a.path) && isReferenced(a))
    ) {
      setProblem(t('所选图片已有文档引用，请刷新后重新选择。'));
      setConfirmTrash(false);
      return;
    }
    const unsaved = p.docs.find(
      (d) =>
        d.path &&
        selected.some(
          (path) =>
            d.path === path || d.path?.startsWith(path + '/') || d.path?.startsWith(path + '\\'),
        ) &&
        d.content !== d.saved,
    );
    if (unsaved) {
      setProblem(t('请先保存“{0}”的修改，再移到回收站。', undefined, [unsaved.name]));
      setConfirmTrash(false);
      return;
    }
    await run(async (isCurrent) => {
      if (p.tab === 'attachments' && p.root) {
        const fresh = await invoke<Attachment[]>('attachment_inventory', { path: p.root });
        if (fresh.some((a) => selected.includes(a.path) && isReferenced(a)))
          throw new Error(t('附件引用刚刚变化，请刷新列表后重新选择。'));
      }
      const result = await invoke<{ moved: string[]; failures: { path: string; error: string }[] }>(
        'trash_entries',
        { paths: selected },
      );
      p.onTrashed(result.moved);
      if (isCurrent()) {
        p.onRefresh();
        setRevision((v) => v + 1);
        setConfirmTrash(false);
        if (result.failures.length)
          setProblem(result.failures.map((f) => `${fileName(f.path)}：${f.error}`).join('\n'));
      }
      if (result.moved.length)
        p.onNotify(
          t('已将 {0} 项移到系统回收站，可从回收站恢复。', undefined, [result.moved.length]),
        );
    });
  }
  return (
    <aside className="workspace-panel" aria-label={t('文档工具面板')}>
      <div className="workspace-title">
        <strong>{t(labels[p.tab])}</strong>
        <button
          aria-label={t('刷新面板')}
          onClick={() => {
            invalidateWorkspaceIndex();
            setRevision((v) => v + 1);
          }}
        >
          <RefreshCw size={15} />
        </button>
        <button aria-label={t('关闭工具面板')} onClick={p.onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="workspace-tabs">
        {(Object.keys(labels) as WorkspaceTab[]).map((tab) => (
          <button key={tab} className={p.tab === tab ? 'active' : ''} onClick={() => p.onTab(tab)}>
            {t(labels[tab])}
          </button>
        ))}
      </div>
      <div className="workspace-body">
        {waiting && (
          <p role="status">
            {indexTab
              ? t('正在后台更新索引…', 'Updating index in the background…')
              : t('正在读取…')}
          </p>
        )}
        {indexTab && (indexError || indexed.error) && (
          <p className="panel-error" role="alert">
            {indexError || indexed.error}
          </p>
        )}
        {problem && (
          <p className="panel-error" role="alert">
            {problem}
          </p>
        )}
        {!desktop && (
          <p className="panel-note">
            {t('浏览器可查看已打开文档的链接与标签。本地历史、回收站与 Git 请在桌面版使用。')}
          </p>
        )}
        {p.tab === 'history' && (
          <>
            <p className="panel-note">
              {t(
                '每篇文档最多保留 50 个版本，历史总空间最多 200MB。恢复后可继续编辑，保存时会保留被替换版本。',
              )}
            </p>
            {!p.current.path && <p>{t('先将草稿保存为文件，之后的修改会记录在这里。')}</p>}
            {!loading && !history.length && p.current.path && (
              <p>{t('还没有历史版本。保存修改后会自动记录。')}</p>
            )}
            {history.map((h) => (
              <button
                className="panel-list-item"
                key={h.id}
                onClick={() =>
                  void run(async (isCurrent) => {
                    const version = await invoke<DiskFile>('history_read', {
                      path: p.current.path,
                      id: h.id,
                    });
                    if (isCurrent()) setSelectedHistory(version);
                  })
                }
              >
                <span>{new Date(h.createdAt).toLocaleString(language)}</span>
                <small>{Math.ceil(h.size / 1024)} KB</small>
              </button>
            ))}
            {selectedHistory && selectedHistory.path === p.current.path && (
              <>
                <h4>{t('历史版本与当前内容')}</h4>
                <DiffView before={p.current.content} after={selectedHistory.content} />
                <button
                  className="primary panel-wide"
                  onClick={() => p.onRestore(selectedHistory.content)}
                >
                  {t('恢复到编辑器（可撤销）')}
                </button>
              </>
            )}
          </>
        )}
        {p.tab === 'backlinks' && (
          <>
            <p className="panel-note">{t('引用当前文档的页面。工作区未保存的文字也参与索引。')}</p>
            {!waiting && !incoming.length && (
              <p>
                {t('还没有其他文档链接到这里。可通过“插入链接”选择工作区文档，或输入 [[文档名]]。')}
              </p>
            )}
            {incoming.slice(0, limit).map((d) => (
              <button className="panel-list-item" key={d.path} onClick={() => p.onOpen(d.path)}>
                <FileText size={15} />
                <span>{d.name || fileName(d.path)}</span>
              </button>
            ))}
            {incoming.length > limit && (
              <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                {t('显示更多', 'Show more')} ({incoming.length - limit})
              </button>
            )}
            <h4>{t('本文链接')}</h4>
            {indexed.result.outgoing.slice(0, limit).map((l, i) => (
              <p className="panel-note" key={i}>
                {l.wiki ? t('双链') : t('链接')} · {l.target}
              </p>
            ))}
            {indexed.result.outgoing.length > limit && (
              <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                {t('显示更多本文链接', 'Show more outgoing links')} (
                {indexed.result.outgoing.length - limit})
              </button>
            )}
          </>
        )}
        {p.tab === 'graph' && (
          <LinkGraph
            documents={[]}
            preparedGraph={indexed.result.graph}
            currentPath={p.current.path || p.current.id}
            onOpen={p.onOpen}
          />
        )}
        {p.tab === 'tags' && (
          <>
            <input
              aria-label={t('检索标签')}
              placeholder={t('输入标签名…')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {tags
              .filter(([tag]) => tag.includes(filter))
              .slice(0, limit)
              .map(([tag, documents]) => (
                <details
                  key={tag}
                  open={openTags.has(tag)}
                  onToggle={(e) => {
                    const open = e.currentTarget.open;
                    setOpenTags((old) => {
                      if (old.has(tag) === open) return old;
                      const next = new Set(old);
                      if (open) next.add(tag);
                      else next.delete(tag);
                      return next;
                    });
                  }}
                >
                  <summary>
                    #{tag} <small>{documents.length}</small>
                  </summary>
                  {openTags.has(tag) &&
                    documents.slice(0, tagLimits[tag] || 100).map((d) => (
                      <button
                        key={d.path}
                        className="panel-list-item"
                        onClick={() => p.onOpen(d.path)}
                      >
                        {d.name || fileName(d.path)}
                      </button>
                    ))}
                  {openTags.has(tag) && documents.length > (tagLimits[tag] || 100) && (
                    <button
                      className="panel-wide"
                      onClick={() => setTagLimits((v) => ({ ...v, [tag]: (v[tag] || 100) + 100 }))}
                    >
                      {t('显示更多', 'Show more')}
                    </button>
                  )}
                </details>
              ))}
            {tags.filter(([tag]) => tag.includes(filter)).length > limit && (
              <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                {t('显示更多标签', 'Show more tags')}
              </button>
            )}
            {!waiting && !tags.length && (
              <p>{t('在正文中写下 #标签 即可归类。代码中的 # 不会被算作标签。')}</p>
            )}
          </>
        )}
        {p.tab === 'attachments' && (
          <>
            <p className="panel-note">
              {t('展示工作文件夹中的图片。清理只允许选择未被引用的图片，并移到系统回收站。')}
            </p>
            {!p.root && <p>{t('请先打开工作文件夹。')}</p>}
            {attachments.slice(0, limit).map((a) => {
              const referenced = isReferenced(a);
              return (
                <label className="panel-check" key={a.path}>
                  <input
                    type="checkbox"
                    disabled={referenced || loading}
                    checked={selected.includes(a.path)}
                    onChange={() => toggle(a.path)}
                  />
                  <span>
                    {fileName(a.path)}
                    <small>
                      {(a.size / 1024).toFixed(1)} KB · {referenced ? t('已引用') : t('未引用')}
                      {a.references.length ? ` · ${a.references.map(fileName).join('、')}` : ''}
                    </small>
                  </span>
                </label>
              );
            })}
            {attachments.length > limit && (
              <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                {t('显示更多附件', 'Show more attachments')} ({attachments.length - limit})
              </button>
            )}
            {!!selected.length && (
              <button className="danger panel-wide" onClick={() => setConfirmTrash(true)}>
                {t('预览清理') + ' '}
                {selected.length} {' ' + t('张图片')}
              </button>
            )}
            {!loading && p.root && !attachments.length && <p>{t('没有发现本地图片附件。')}</p>}
          </>
        )}
        {p.tab === 'files' && (
          <>
            <p className="panel-note">
              {t(
                '可批量移到回收站。重命名或移动前，可预览并选择需要更新的文档引用。',
                'Move files to the trash in batches. Before renaming or moving, preview and select the document references to update.',
              )}
            </p>
            <input
              aria-label={t('管理文件筛选')}
              placeholder={t('筛选文件或文件夹…')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {allFiles
              .filter((f) => f.name.includes(filter))
              .slice(0, limit)
              .map((f) => (
                <div className="managed-file" key={f.path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(f.path)}
                      onChange={() => toggle(f.path)}
                    />
                    {f.directory ? <FolderOpen size={15} /> : <FileText size={15} />}
                    <span>{f.name}</span>
                  </label>
                  <button
                    disabled={!desktop || loading}
                    onClick={() => setRename({ path: f.path, name: f.name })}
                  >
                    {t('重命名')}
                  </button>
                </div>
              ))}
            {allFiles.filter((f) => f.name.includes(filter)).length > limit && (
              <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                {t('显示更多文件', 'Show more files')}
              </button>
            )}
            {rename && (
              <form
                className="panel-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async (isCurrent) => {
                    await p.onRename(rename.path, rename.name);
                    if (isCurrent()) {
                      p.onRefresh();
                      setRename(undefined);
                    }
                  });
                }}
              >
                <input
                  aria-label={t('新名称')}
                  value={rename.name}
                  onChange={(e) => setRename({ ...rename, name: e.target.value })}
                />
                <button type="submit" disabled={loading}>
                  {t('确定')}
                </button>
                <button type="button" onClick={() => setRename(undefined)}>
                  {t('取消')}
                </button>
              </form>
            )}
            {!!selected.length && (
              <button
                className="danger panel-wide"
                disabled={!desktop || loading}
                onClick={() => setConfirmTrash(true)}
              >
                <Trash2 size={14} /> {' ' + t('移到回收站…')}
              </button>
            )}
            {!p.root && <p>{t('请先打开工作文件夹。')}</p>}
          </>
        )}
        {p.tab === 'git' && (
          <>
            {!p.root && <p>{t('请先打开一个工作文件夹。')}</p>}
            {git && !git.available && <p>{t('未找到 Git。请先安装 Git 并重新启动 Markwrite。')}</p>}
            {git?.available && !git.repository && (
              <>
                <p>{t('这个文件夹还没有 Git 仓库。')}</p>
                <button
                  onClick={() =>
                    void run(async (isCurrent) => {
                      await invoke('git_init', { path: p.root });
                      if (isCurrent()) setRevision((v) => v + 1);
                    })
                  }
                >
                  {t('在当前文件夹初始化 Git')}
                </button>
              </>
            )}
            {git?.repository && (
              <>
                <p>
                  {t('分支：')}
                  <strong>{git.branch || t('尚无提交')}</strong>
                </p>
                <p className="panel-note">
                  {t('只提交明确选择的文件，不会自动推送到远程。冲突文件须编辑解决后再提交。')}
                </p>
                {git.entries.slice(0, limit).map((entry) => (
                  <div className="git-row" key={entry.path}>
                    <input
                      type="checkbox"
                      aria-label={t('提交 {0}', undefined, [entry.path])}
                      checked={selected.includes(entry.path)}
                      onChange={() => toggle(entry.path)}
                    />
                    <button
                      onClick={() =>
                        void run(async (isCurrent) => {
                          const diff = await invoke<string>('git_diff', {
                            path: p.root,
                            file: entry.path,
                          });
                          if (isCurrent()) setGitDiff(diff);
                        })
                      }
                    >
                      <code>
                        {entry.index}
                        {entry.worktree}
                      </code>{' '}
                      {entry.path}
                    </button>
                  </div>
                ))}
                {git.entries.length > limit && (
                  <button className="panel-wide" onClick={() => setLimit((v) => v + 100)}>
                    {t('显示更多 Git 文件', 'Show more Git files')} ({git.entries.length - limit})
                  </button>
                )}
                {!git.entries.length && <p>{t('工作区没有改动。')}</p>}
                {gitDiff && (
                  <pre className="git-diff" aria-label={t('Git 差异')}>
                    {gitDiff}
                  </pre>
                )}
                <textarea
                  aria-label={t('提交说明')}
                  placeholder={t('描述这次修改…')}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <button
                  className="primary panel-wide"
                  disabled={!selected.length || !message.trim() || loading}
                  onClick={() =>
                    void run(async (isCurrent) => {
                      const id = await invoke<string>('git_commit', {
                        path: p.root,
                        paths: selected,
                        message,
                      });
                      p.onNotify(t('已创建本地提交 {0}', undefined, [id.slice(0, 8)]));
                      if (isCurrent()) {
                        setMessage('');
                        setGitDiff('');
                        setRevision((v) => v + 1);
                      }
                    })
                  }
                >
                  {t('提交选中的') + ' '}
                  {selected.length} {' ' + t('个文件')}
                </button>
              </>
            )}
          </>
        )}
        {confirmTrash && (
          <div className="trash-confirm" role="alertdialog" aria-label={t('确认移到回收站')}>
            <h4>{t('确认移到回收站？')}</h4>
            <ul>
              {selected.map((path) => (
                <li key={path}>{fileName(path)}</li>
              ))}
            </ul>
            <p>{t('可从系统回收站恢复。其他文档里的引用不会自动修改。')}</p>
            <div className="panel-actions">
              <button onClick={() => setConfirmTrash(false)}>{t('取消')}</button>
              <button className="danger" disabled={loading} onClick={() => void trash()}>
                {t('确认移到回收站')}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
