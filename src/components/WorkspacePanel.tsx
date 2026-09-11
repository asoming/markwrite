import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, RefreshCw, FolderOpen, FileText, Trash2 } from 'lucide-react';
import type { DiskFile, Document, FileEntry } from '../lib/types';
import { desktop } from '../lib/platform';
import { backlinks, documentReferences, fileName, type IndexedDocument } from '../lib/workspace';
import DiffView from './DiffView';
import './workspace.css';

export type WorkspaceTab = 'history' | 'backlinks' | 'tags' | 'attachments' | 'git' | 'files';
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
  history: '版本历史',
  backlinks: '反向链接',
  tags: '标签',
  attachments: '附件',
  git: 'Git',
  files: '文件管理',
};
const error = (e: unknown) => (e instanceof Error ? e.message : String(e));
export default function WorkspacePanel(p: Props) {
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
  useEffect(() => {
    let disposed = false;
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
      } else if (p.tab === 'backlinks' || p.tab === 'tags') {
        const disk =
          desktop && p.root
            ? await invoke<DiskFile[]>('workspace_documents', { path: p.root })
            : [];
        const buffers = p.docs.map((d) => ({
          path: d.path || d.id,
          content: d.content,
          name: d.name,
        }));
        if (!disposed)
          setIndex([...buffers, ...disk.filter((d) => !buffers.some((b) => b.path === d.path))]);
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
  const liveIndex = useMemo(() => {
    const buffers = p.docs.map((d) => ({ path: d.path || d.id, content: d.content, name: d.name }));
    return [...buffers, ...index.filter((d) => !buffers.some((b) => b.path === d.path))];
  }, [index, p.docs]);
  const tags = useMemo(() => {
    const map = new Map<string, IndexedDocument[]>();
    for (const d of liveIndex)
      for (const tag of documentReferences(d.content).tags)
        map.set(tag, [...(map.get(tag) || []), d]);
    return [...map].sort((a, b) => a[0].localeCompare(b[0]));
  }, [liveIndex]);
  const incoming = useMemo(
    () => backlinks(p.current.path || p.current.id, liveIndex),
    [liveIndex, p.current.path, p.current.id],
  );
  const toggle = (path: string) =>
    setSelected((old) => (old.includes(path) ? old.filter((x) => x !== path) : [...old, path]));
  async function run(action: () => Promise<void>) {
    setProblem('');
    setLoading(true);
    try {
      await action();
    } catch (e) {
      setProblem(error(e));
    } finally {
      setLoading(false);
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
      setProblem('所选图片已有文档引用，请刷新后重新选择。');
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
      setProblem(`请先保存“${unsaved.name}”的修改，再移到回收站。`);
      setConfirmTrash(false);
      return;
    }
    await run(async () => {
      if (p.tab === 'attachments' && p.root) {
        const fresh = await invoke<Attachment[]>('attachment_inventory', { path: p.root });
        if (fresh.some((a) => selected.includes(a.path) && isReferenced(a)))
          throw new Error('附件引用刚刚变化，请刷新列表后重新选择。');
      }
      const result = await invoke<{ moved: string[]; failures: { path: string; error: string }[] }>(
        'trash_entries',
        { paths: selected },
      );
      p.onTrashed(result.moved);
      p.onRefresh();
      setRevision((v) => v + 1);
      if (result.failures.length)
        setProblem(result.failures.map((f) => `${fileName(f.path)}：${f.error}`).join('\n'));
      if (result.moved.length)
        p.onNotify(`已将 ${result.moved.length} 项移到系统回收站，可从回收站恢复。`);
    });
    setConfirmTrash(false);
  }
  return (
    <aside className="workspace-panel" aria-label="文档工具面板">
      <div className="workspace-title">
        <strong>{labels[p.tab]}</strong>
        <button aria-label="刷新面板" onClick={() => setRevision((v) => v + 1)}>
          <RefreshCw size={15} />
        </button>
        <button aria-label="关闭工具面板" onClick={p.onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="workspace-tabs">
        {(Object.keys(labels) as WorkspaceTab[]).map((tab) => (
          <button key={tab} className={p.tab === tab ? 'active' : ''} onClick={() => p.onTab(tab)}>
            {labels[tab]}
          </button>
        ))}
      </div>
      <div className="workspace-body">
        {loading && <p role="status">正在读取…</p>}
        {problem && (
          <p className="panel-error" role="alert">
            {problem}
          </p>
        )}
        {!desktop && (
          <p className="panel-note">
            浏览器可查看已打开文档的链接与标签。本地历史、回收站与 Git 请在桌面版使用。
          </p>
        )}
        {p.tab === 'history' && (
          <>
            <p className="panel-note">
              每篇文档最多保留 50 个版本，历史总空间最多
              200MB。恢复后可继续编辑，保存时会保留被替换版本。
            </p>
            {!p.current.path && <p>先将草稿保存为文件，之后的修改会记录在这里。</p>}
            {!loading && !history.length && p.current.path && (
              <p>还没有历史版本。保存修改后会自动记录。</p>
            )}
            {history.map((h) => (
              <button
                className="panel-list-item"
                key={h.id}
                onClick={() =>
                  void run(async () =>
                    setSelectedHistory(
                      await invoke<DiskFile>('history_read', { path: p.current.path, id: h.id }),
                    ),
                  )
                }
              >
                <span>{new Date(h.createdAt).toLocaleString()}</span>
                <small>{Math.ceil(h.size / 1024)} KB</small>
              </button>
            ))}
            {selectedHistory && selectedHistory.path === p.current.path && (
              <>
                <h4>历史版本与当前内容</h4>
                <DiffView before={p.current.content} after={selectedHistory.content} />
                <button
                  className="primary panel-wide"
                  onClick={() => p.onRestore(selectedHistory.content)}
                >
                  恢复到编辑器（可撤销）
                </button>
              </>
            )}
          </>
        )}
        {p.tab === 'backlinks' && (
          <>
            <p className="panel-note">引用当前文档的页面。工作区未保存的文字也参与索引。</p>
            {!loading && !incoming.length && (
              <p>还没有其他文档链接到这里。可通过“插入链接”选择工作区文档，或输入 [[文档名]]。</p>
            )}
            {incoming.map((d) => (
              <button className="panel-list-item" key={d.path} onClick={() => p.onOpen(d.path)}>
                <FileText size={15} />
                <span>{d.name || fileName(d.path)}</span>
              </button>
            ))}
            <h4>本文链接</h4>
            {documentReferences(p.current.content).links.map((l, i) => (
              <p className="panel-note" key={i}>
                {l.wiki ? '双链' : '链接'} · {l.target}
              </p>
            ))}
          </>
        )}
        {p.tab === 'tags' && (
          <>
            <input
              aria-label="检索标签"
              placeholder="输入标签名…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {tags
              .filter(([tag]) => tag.includes(filter))
              .map(([tag, documents]) => (
                <details key={tag} open>
                  <summary>
                    #{tag} <small>{documents.length}</small>
                  </summary>
                  {documents.map((d) => (
                    <button
                      key={d.path}
                      className="panel-list-item"
                      onClick={() => p.onOpen(d.path)}
                    >
                      {d.name || fileName(d.path)}
                    </button>
                  ))}
                </details>
              ))}
            {!loading && !tags.length && (
              <p>在正文中写下 #标签 即可归类。代码中的 # 不会被算作标签。</p>
            )}
          </>
        )}
        {p.tab === 'attachments' && (
          <>
            <p className="panel-note">
              展示工作文件夹中的图片。清理只允许选择未被引用的图片，并移到系统回收站。
            </p>
            {!p.root && <p>请先打开工作文件夹。</p>}
            {attachments.map((a) => {
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
                      {(a.size / 1024).toFixed(1)} KB · {referenced ? '已引用' : '未引用'}
                      {a.references.length ? ` · ${a.references.map(fileName).join('、')}` : ''}
                    </small>
                  </span>
                </label>
              );
            })}
            {!!selected.length && (
              <button className="danger panel-wide" onClick={() => setConfirmTrash(true)}>
                预览清理 {selected.length} 张图片
              </button>
            )}
            {!loading && p.root && !attachments.length && <p>没有发现本地图片附件。</p>}
          </>
        )}
        {p.tab === 'files' && (
          <>
            <p className="panel-note">
              可批量移到回收站。文件夹重命名会更新打开文档的路径，不会自动改写其他文档中的链接。
            </p>
            <input
              aria-label="管理文件筛选"
              placeholder="筛选文件或文件夹…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {allFiles
              .filter((f) => f.name.includes(filter))
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
                    disabled={!desktop}
                    onClick={() => setRename({ path: f.path, name: f.name })}
                  >
                    重命名
                  </button>
                </div>
              ))}
            {rename && (
              <form
                className="panel-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await p.onRename(rename.path, rename.name);
                    p.onRefresh();
                    setRename(undefined);
                  });
                }}
              >
                <input
                  aria-label="新名称"
                  value={rename.name}
                  onChange={(e) => setRename({ ...rename, name: e.target.value })}
                />
                <button type="submit">确定</button>
                <button type="button" onClick={() => setRename(undefined)}>
                  取消
                </button>
              </form>
            )}
            {!!selected.length && (
              <button
                className="danger panel-wide"
                disabled={!desktop || loading}
                onClick={() => setConfirmTrash(true)}
              >
                <Trash2 size={14} /> 移到回收站…
              </button>
            )}
            {!p.root && <p>请先打开工作文件夹。</p>}
          </>
        )}
        {p.tab === 'git' && (
          <>
            {!p.root && <p>请先打开一个工作文件夹。</p>}
            {git && !git.available && <p>未找到 Git。请先安装 Git 并重新启动墨页。</p>}
            {git?.available && !git.repository && (
              <>
                <p>这个文件夹还没有 Git 仓库。</p>
                <button
                  onClick={() =>
                    void run(async () => {
                      await invoke('git_init', { path: p.root });
                      setRevision((v) => v + 1);
                    })
                  }
                >
                  在当前文件夹初始化 Git
                </button>
              </>
            )}
            {git?.repository && (
              <>
                <p>
                  分支：<strong>{git.branch || '尚无提交'}</strong>
                </p>
                <p className="panel-note">
                  只提交明确选择的文件，不会自动推送到远程。冲突文件须编辑解决后再提交。
                </p>
                {git.entries.map((entry) => (
                  <div className="git-row" key={entry.path}>
                    <input
                      type="checkbox"
                      aria-label={`提交 ${entry.path}`}
                      checked={selected.includes(entry.path)}
                      onChange={() => toggle(entry.path)}
                    />
                    <button
                      onClick={() =>
                        void run(async () =>
                          setGitDiff(
                            await invoke<string>('git_diff', { path: p.root, file: entry.path }),
                          ),
                        )
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
                {!git.entries.length && <p>工作区没有改动。</p>}
                {gitDiff && (
                  <pre className="git-diff" aria-label="Git 差异">
                    {gitDiff}
                  </pre>
                )}
                <textarea
                  aria-label="提交说明"
                  placeholder="描述这次修改…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <button
                  className="primary panel-wide"
                  disabled={!selected.length || !message.trim() || loading}
                  onClick={() =>
                    void run(async () => {
                      const id = await invoke<string>('git_commit', {
                        path: p.root,
                        paths: selected,
                        message,
                      });
                      p.onNotify(`已创建本地提交 ${id.slice(0, 8)}`);
                      setMessage('');
                      setGitDiff('');
                      setRevision((v) => v + 1);
                    })
                  }
                >
                  提交选中的 {selected.length} 个文件
                </button>
              </>
            )}
          </>
        )}
        {confirmTrash && (
          <div className="trash-confirm" role="alertdialog" aria-label="确认移到回收站">
            <h4>确认移到回收站？</h4>
            <ul>
              {selected.map((path) => (
                <li key={path}>{fileName(path)}</li>
              ))}
            </ul>
            <p>可从系统回收站恢复。其他文档里的引用不会自动修改。</p>
            <div className="panel-actions">
              <button onClick={() => setConfirmTrash(false)}>取消</button>
              <button className="danger" disabled={loading} onClick={() => void trash()}>
                确认移到回收站
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
