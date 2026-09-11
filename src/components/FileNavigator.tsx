import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Pin,
  PinOff,
  RefreshCw,
  X,
} from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { fileName, pathKey } from '../lib/workspace';
import type { Document, FileEntry } from '../lib/types';

function Tree({
  entries,
  active,
  filter,
  open,
  depth = 0,
}: {
  entries: FileEntry[];
  active?: string;
  filter: string;
  open: (path: string) => void;
  depth?: number;
}) {
  const [expansion, setExpansion] = useState<Map<string, boolean>>(new Map());
  const isExpanded = (entry: FileEntry): boolean =>
    !!filter ||
    (expansion.get(entry.path) ??
      (!!active && pathKey(active).startsWith(`${pathKey(entry.path).replace(/\/$/, '')}/`)));
  const matches = (entry: FileEntry): boolean =>
    entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) ||
    !!entry.children?.some(matches);
  return (
    <>
      {entries.filter(matches).map((entry) =>
        entry.directory ? (
          <div key={entry.path}>
            <button
              className="tree-row folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              aria-expanded={isExpanded(entry)}
              title={entry.path}
              onClick={() =>
                setExpansion((old) => {
                  const next = new Map(old);
                  next.set(entry.path, !isExpanded(entry));
                  return next;
                })
              }
            >
              {!isExpanded(entry) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <FolderOpen size={14} />
              <span>{entry.name}</span>
            </button>
            {isExpanded(entry) && (
              <Tree
                entries={entry.children || []}
                active={active}
                filter={filter}
                open={open}
                depth={depth + 1}
              />
            )}
          </div>
        ) : (
          <button
            key={entry.path}
            className={`tree-row ${active && pathKey(entry.path) === pathKey(active) ? 'selected' : ''}`}
            aria-current={active && pathKey(entry.path) === pathKey(active) ? 'page' : undefined}
            style={{ paddingLeft: 25 + depth * 14 }}
            title={entry.path}
            onClick={() => open(entry.path)}
          >
            <FileText size={14} />
            <span>{entry.name}</span>
          </button>
        ),
      )}
    </>
  );
}

export default function FileNavigator({
  root,
  entries,
  current,
  drafts,
  recents,
  following,
  loading,
  error,
  onFollow,
  onFolder,
  onRefresh,
  onOpen,
  onDraft,
  onNewFile,
  onNewFolder,
  onRemoveRecent,
}: {
  root?: string;
  entries: FileEntry[];
  current: Document;
  drafts: Document[];
  recents: { path: string; name: string }[];
  following: boolean;
  loading: boolean;
  error: string;
  onFollow: (follow: boolean) => void;
  onFolder: () => void;
  onRefresh: () => void;
  onOpen: (path: string) => void;
  onDraft: (id: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRemoveRecent: (path: string) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  return (
    <div className="file-navigator">
      <div className="folder-heading">
        <span title={root}>{root ? fileName(root) : t('文件夹', 'Folder')}</span>
        {root && (
          <button
            className={`icon-button ${!following ? 'active' : ''}`}
            aria-label={
              following
                ? t('固定此文件夹', 'Pin this folder')
                : t('跟随当前文件', 'Follow current file')
            }
            title={
              following
                ? t('固定此文件夹', 'Pin this folder')
                : t('跟随当前文件', 'Follow current file')
            }
            onClick={() => onFollow(!following)}
          >
            {following ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
        <button
          className="icon-button"
          title={t('打开文件夹')}
          aria-label={t('打开文件夹')}
          onClick={onFolder}
        >
          <FolderOpen size={15} />
        </button>
        <button
          className="icon-button"
          title={t('新建文档')}
          aria-label={t('新建文档')}
          onClick={onNewFile}
        >
          <FilePlus2 size={15} />
        </button>
      </div>
      {root && (
        <>
          <div className="folder-filter">
            <input
              aria-label={t('筛选文件名')}
              placeholder={t('筛选文件…')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              className="icon-button"
              title={t('新建文件夹')}
              aria-label={t('新建文件夹')}
              onClick={onNewFolder}
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="icon-button"
              title={t('刷新文件树')}
              aria-label={t('刷新文件树')}
              onClick={onRefresh}
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <Tree key={root} entries={entries} active={current.path} filter={filter} open={onOpen} />
        </>
      )}
      {loading && (
        <p className="navigator-note" role="status">
          {t('正在读取文件夹…', 'Loading folder…')}
        </p>
      )}
      {error && (
        <p className="navigator-note" role="status">
          {error} <button onClick={onRefresh}>{t('重试', 'Retry')}</button>
        </p>
      )}
      {!root && !loading && (
        <p className="navigator-note">
          {t(
            '打开 Markdown 后，这里会显示它所在文件夹。',
            'Open a Markdown file to browse its folder here.',
          )}
        </p>
      )}
      {root && entries.length === 0 && !loading && (
        <p className="navigator-note">{t('没有 Markdown 文件', 'No Markdown files')}</p>
      )}
      {drafts.length > 0 && (
        <>
          <div className="section-caption">
            <span>{t('草稿', 'Drafts')}</span>
          </div>
          {drafts.map((item) => (
            <button
              className={`tree-row document-row ${item.id === current.id ? 'selected' : ''}`}
              key={item.id}
              title={item.name}
              onClick={() => onDraft(item.id)}
            >
              <FileText size={14} />
              <span>{item.name}</span>
              {item.content !== item.saved && <i className="dirty-dot" />}
            </button>
          ))}
        </>
      )}
      {!!recents.length && (
        <details className="navigator-recents">
          <summary>{t('最近打开', 'Recent files')}</summary>
          {recents.slice(0, 8).map((item) => (
            <div className="recent-file" key={item.path}>
              <button className="tree-row" title={item.path} onClick={() => onOpen(item.path)}>
                <FileText size={14} />
                <span>{item.name}</span>
              </button>
              <button
                className="remove-recent"
                aria-label={t('移除最近记录 {0}', 'Remove recent entry {0}', [item.name])}
                onClick={() => onRemoveRecent(item.path)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
