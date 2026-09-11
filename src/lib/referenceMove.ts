import type { ReferenceAnalysis, ReferenceDocument, ReferenceChange } from './referenceMaintenance';
import type { DiskFile, Document } from './types';
import { pathKey } from './workspace';

export type PreparedMove = ReferenceAnalysis & {
  from: string;
  to: string;
  disk: Map<string, DiskFile>;
  buffers: Map<string, { id: string; content: string; version?: string }>;
};
export function analyzeInWorker(
  documents: ReferenceDocument[],
  from: string,
  to: string,
): Promise<ReferenceAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./referencePlan.worker.ts', import.meta.url), {
      type: 'module',
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(
        new Error(
          '引用分析超时，请缩小工作文件夹 / Reference analysis timed out; choose a smaller workspace',
        ),
      );
    }, 60_000);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (event) => {
      finish();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
    };
    worker.onerror = () => {
      finish();
      reject(new Error('无法分析文件引用 / Could not analyze file references'));
    };
    worker.postMessage({ documents, from, to });
  });
}
export async function prepareMove(
  from: string,
  to: string,
  documents: ReferenceDocument[],
  buffers: Document[],
  read: (path: string) => Promise<DiskFile>,
  analyze = analyzeInWorker,
): Promise<PreparedMove> {
  const merged = new Map(documents.map((document) => [pathKey(document.path), document]));
  for (const doc of buffers)
    if (doc.path)
      merged.set(pathKey(doc.path), { path: doc.path, content: doc.content, name: doc.name });
  const analysis = await analyze([...merged.values()], from, to);
  const disk = new Map<string, DiskFile>();
  const snapshot = new Map<string, { id: string; content: string; version?: string }>();
  for (const doc of buffers)
    if (doc.path)
      snapshot.set(pathKey(doc.path), { id: doc.id, content: doc.content, version: doc.version });
  // Read only the files that need changes; their byte versions guard the confirmed write.
  for (const change of analysis.changes) {
    const file = await read(change.path);
    const opened = snapshot.get(pathKey(change.path));
    if (opened ? opened.version !== file.version : file.content !== change.before)
      throw new Error('CONFLICT:文件已改变，请刷新后重试 / A file changed; refresh and try again');
    disk.set(pathKey(change.path), file);
  }
  return { from, to, ...analysis, disk, buffers: snapshot };
}
export function selectedMoveChanges(plan: PreparedMove, selected: string[], buffers: Document[]) {
  const keys = new Set(selected.map(pathKey));
  const changes: Array<Omit<ReferenceChange, 'count'> & { expectedVersion: string }> = [];
  for (const change of plan.changes) {
    if (!keys.has(pathKey(change.path))) continue;
    const previous = plan.buffers.get(pathKey(change.path));
    const current = buffers.find((doc) => doc.path && pathKey(doc.path) === pathKey(change.path));
    if (
      (previous &&
        (!current ||
          previous.id !== current.id ||
          previous.content !== current.content ||
          previous.version !== current.version)) ||
      (!previous && current)
    )
      throw new Error(
        'CONFLICT:预览后文档已改变，请重新预览 / A document changed after the preview; preview again',
      );
    const disk = plan.disk.get(pathKey(change.path));
    if (!disk) throw new Error('Missing reference snapshot');
    changes.push({
      path: change.path,
      nextPath: change.nextPath,
      before: disk.content,
      after: change.after,
      expectedVersion: disk.version,
    });
  }
  return changes;
}
