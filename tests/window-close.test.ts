import { afterEach, expect, it } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit, TauriEvent } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import capability from '../src-tauri/capabilities/default.json';

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
