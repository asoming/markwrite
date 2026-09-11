import type { Document } from './types';

type CloseDocument = Pick<Document, 'content' | 'saved' | 'status'>;
type SnapshotContext<T> = {
  documents: () => T[];
  saving: () => boolean;
  flush: (snapshot: T[]) => Promise<void>;
};
type CloseContext<T extends CloseDocument> = SnapshotContext<T> & {
  authorization: { current: T[] | null };
  onBusy: () => void;
  onUnsaved: () => void;
  onChanged: () => void;
  onError: (error: unknown) => void;
};

export function hasUnsavedWork(documents: readonly CloseDocument[]): boolean {
  return documents.some(
    (d) => d.content !== d.saved || d.status === 'conflict' || d.status === 'error',
  );
}

/** A successful flush only authorizes the exact immutable document snapshot it wrote. */
export async function flushStableCloseSnapshot<T>(
  context: SnapshotContext<T>,
): Promise<T[] | null> {
  const snapshot = context.documents();
  if (context.saving()) return null;
  await context.flush(snapshot);
  return !context.saving() && context.documents() === snapshot ? snapshot : null;
}

/** Passed directly to the real Tauri onCloseRequested API, which awaits this handler. */
export function createWindowCloseHandler<T extends CloseDocument>(context: CloseContext<T>) {
  return async (event: { preventDefault: () => void }) => {
    const snapshot = context.documents();
    const busy = context.saving();
    const authorized = context.authorization.current;
    // Consume once. A stale permission must never bypass a later close request.
    context.authorization.current = null;
    if (authorized === snapshot && !busy) return;
    if (busy) {
      event.preventDefault();
      context.onBusy();
      return;
    }
    if (hasUnsavedWork(snapshot)) {
      event.preventDefault();
      context.onUnsaved();
      return;
    }
    try {
      if (!(await flushStableCloseSnapshot(context))) {
        event.preventDefault();
        context.onChanged();
      }
    } catch (error) {
      event.preventDefault();
      context.onError(error);
    }
  };
}
