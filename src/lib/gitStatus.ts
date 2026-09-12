import { t } from './i18n';
export type GitFileState = { path: string; index: string; worktree: string };
export function isGitConflict(entry: GitFileState) {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.index + entry.worktree);
}
export function gitStateLabel(entry: GitFileState) {
  const conflict: Record<string, [string, string]> = {
    DD: ['双方删除', 'Deleted by both sides'],
    AU: ['本地新增，合并冲突', 'Added by us; conflict'],
    UD: ['对方删除，本地修改', 'Deleted by them, modified locally'],
    UA: ['对方新增，合并冲突', 'Added by them; conflict'],
    DU: ['本地删除，对方修改', 'Deleted locally, modified by them'],
    AA: ['双方新增同名文件', 'Both sides added this file'],
    UU: ['双方修改冲突', 'Both sides modified this file'],
  };
  const label = conflict[entry.index + entry.worktree];
  if (label) return t(...label);
  if (entry.index === '?') return t('未跟踪', 'Untracked');
  return [
    entry.index.trim() && t('已暂存', 'Staged'),
    entry.worktree.trim() && t('未暂存修改', 'Unstaged changes'),
  ]
    .filter(Boolean)
    .join(' · ');
}
