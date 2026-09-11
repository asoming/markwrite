import { afterEach, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit, TauriEvent } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import capability from '../src-tauri/capabilities/default.json';
import { createWindowCloseHandler, flushStableCloseSnapshot } from '../src/lib/closeGuard';
import type { Document } from '../src/lib/types';

afterEach(clearMocks);

it('authorizes the actual SDK commands used when closing the main window', async () => {
  const commands: string[] = [];
  mockWindows('main');
  mockIPC(
    (command) => {
      commands.push(command);
    },
    { shouldMockEvents: true },
  );
  const win = getCurrentWindow();
  const unlisten = await win.onCloseRequested(() => {});
  await win.close();
  // The native close request becomes this frontend event. The real SDK then
  // destroys the window after the application allows the request.
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  expect(commands).toContain('plugin:window|close');
  expect(commands).toContain('plugin:window|destroy');
  for (const command of commands) {
    const name = command.split('|')[1];
    expect(capability.permissions).toContain(`core:window:allow-${name}`);
  }
  unlisten();
});

it('does not destroy the window when unsaved work prevents closing', async () => {
  const commands: string[] = [];
  mockWindows('main');
  mockIPC(
    (command) => {
      commands.push(command);
    },
    { shouldMockEvents: true },
  );
  const unlisten = await getCurrentWindow().onCloseRequested((event) => event.preventDefault());
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  expect(commands).not.toContain('plugin:window|destroy');
  unlisten();
});

type TestDocument = Pick<Document, 'content' | 'saved' | 'status'>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function guardedWindow(
  documents: { current: TestDocument[] },
  flush: (snapshot: TestDocument[]) => Promise<void>,
  authorization: { current: TestDocument[] | null } = { current: null },
  saving = () => false,
) {
  const commands: string[] = [];
  mockWindows('main');
  mockIPC(
    (command) => {
      commands.push(command);
    },
    { shouldMockEvents: true },
  );
  const callbacks = { onBusy: vi.fn(), onUnsaved: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  const unlisten = await getCurrentWindow().onCloseRequested(
    createWindowCloseHandler({
      documents: () => documents.current,
      saving,
      authorization,
      flush,
      ...callbacks,
    }),
  );
  return { commands, unlisten, ...callbacks };
}

it('keeps the real SDK window open if documents change during the final session flush', async () => {
  const documents = {
    current: [{ content: 'saved', saved: 'saved', status: 'clean' }] as TestDocument[],
  };
  const began = deferred(),
    finish = deferred();
  const persisted: TestDocument[][] = [];
  const guard = await guardedWindow(documents, async (snapshot) => {
    persisted.push(snapshot);
    began.resolve();
    await finish.promise;
  });
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await began.promise;
  documents.current = [{ content: 'typed while closing', saved: 'saved', status: 'dirty' }];
  finish.resolve();
  await vi.waitFor(() => expect(guard.onChanged).toHaveBeenCalledOnce());
  expect(persisted[0][0].content).toBe('saved');
  expect(documents.current[0].content).toBe('typed while closing');
  expect(guard.commands).not.toContain('plugin:window|destroy');
  guard.unlisten();
});

it('allows the real SDK to destroy an unchanged document only after the flush completes', async () => {
  const documents = {
    current: [{ content: 'saved', saved: 'saved', status: 'clean' }] as TestDocument[],
  };
  const began = deferred(),
    finish = deferred();
  const guard = await guardedWindow(documents, async () => {
    began.resolve();
    await finish.promise;
  });
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await began.promise;
  expect(guard.commands).not.toContain('plugin:window|destroy');
  finish.resolve();
  await vi.waitFor(() => expect(guard.commands).toContain('plugin:window|destroy'));
  expect(guard.onChanged).not.toHaveBeenCalled();
  guard.unlisten();
});

it('honors keeping a draft only for the exact snapshot explicitly flushed for closing', async () => {
  const documents = {
    current: [{ content: 'draft', saved: '', status: 'dirty' }] as TestDocument[],
  };
  const flush = vi.fn(async (_snapshot: TestDocument[]) => {});
  const snapshot = await flushStableCloseSnapshot({
    documents: () => documents.current,
    saving: () => false,
    flush,
  });
  const authorization = { current: snapshot };
  const guard = await guardedWindow(documents, flush, authorization);
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await vi.waitFor(() => expect(guard.commands).toContain('plugin:window|destroy'));
  expect(flush).toHaveBeenCalledOnce();
  expect(guard.onUnsaved).not.toHaveBeenCalled();
  expect(authorization.current).toBeNull();
  guard.unlisten();
});

it('revokes a stale draft authorization when documents change before the native close event', async () => {
  const documents = {
    current: [{ content: 'draft', saved: '', status: 'dirty' }] as TestDocument[],
  };
  const authorization = { current: documents.current as TestDocument[] | null };
  const flush = vi.fn(async (_snapshot: TestDocument[]) => {});
  const guard = await guardedWindow(documents, flush, authorization);
  // Simulate edits after finishClose initiated close IPC but before the native event arrives.
  documents.current = [{ content: 'newer draft', saved: '', status: 'dirty' }];
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await vi.waitFor(() => expect(guard.onUnsaved).toHaveBeenCalledOnce());
  expect(authorization.current).toBeNull();
  expect(flush).not.toHaveBeenCalled();
  expect(guard.commands).not.toContain('plugin:window|destroy');
  guard.unlisten();
});

it('never lets a snapshot authorization bypass an active file operation', async () => {
  const documents = {
    current: [{ content: 'draft', saved: '', status: 'dirty' }] as TestDocument[],
  };
  const authorization = { current: documents.current as TestDocument[] | null };
  const guard = await guardedWindow(
    documents,
    async () => {},
    authorization,
    () => true,
  );
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await vi.waitFor(() => expect(guard.onBusy).toHaveBeenCalledOnce());
  expect(authorization.current).toBeNull();
  expect(guard.commands).not.toContain('plugin:window|destroy');
  guard.unlisten();
});

it('keeps the real SDK window open when the session cannot be persisted', async () => {
  const documents = {
    current: [{ content: 'saved', saved: 'saved', status: 'clean' }] as TestDocument[],
  };
  const failure = new Error('disk full');
  const guard = await guardedWindow(documents, async () => {
    throw failure;
  });
  await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
  await vi.waitFor(() => expect(guard.onError).toHaveBeenCalledWith(failure));
  expect(guard.commands).not.toContain('plugin:window|destroy');
  guard.unlisten();
});
