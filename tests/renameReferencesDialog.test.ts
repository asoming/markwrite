import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RenameReferencesDialog from '../src/components/RenameReferencesDialog';
import { setLanguage } from '../src/lib/i18n';
import type { ReferenceChange } from '../src/lib/referenceMaintenance';

let host: HTMLDivElement;
let root: Root;
const changes: ReferenceChange[] = Array.from({ length: 24 }, (_, index) => ({
  path: `/notes/doc${index}.md`,
  nextPath: `/notes/doc${index}.md`,
  before: '[old](old.md)',
  after: '[old](new.md)',
  count: 1,
}));
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLanguage('zh-CN');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguage('zh-CN');
});
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => (item.getAttribute('aria-label') || item.textContent) === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}

it('pages the file list and confirms only explicitly selected paths, retaining selection between pages', () => {
  const confirm = vi.fn();
  act(() =>
    root.render(
      createElement(RenameReferencesDialog, {
        from: '/notes/old.md',
        to: '/notes/new.md',
        changes,
        onConfirm: confirm,
        onCancel: vi.fn(),
      }),
    ),
  );
  expect(host.querySelectorAll('.reference-file')).toHaveLength(20);
  const first = host.querySelector<HTMLInputElement>('input[aria-label="更新 /notes/doc0.md"]')!;
  act(() => first.click());
  act(() => button('下一页文档').click());
  expect(host.querySelectorAll('.reference-file')).toHaveLength(4);
  act(() =>
    host.querySelector<HTMLInputElement>('input[aria-label="更新 /notes/doc20.md"]')!.click(),
  );
  act(() => button('确认并继续').click());
  expect(confirm).toHaveBeenCalledWith(
    changes
      .map((change) => change.path)
      .filter((path) => !['/notes/doc0.md', '/notes/doc20.md'].includes(path)),
  );
  act(() => button('上一页文档').click());
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="更新 /notes/doc0.md"]')!.checked,
  ).toBe(false);
});

it('allows renaming without automatic reference edits after clearing the selection', () => {
  const confirm = vi.fn();
  act(() =>
    root.render(
      createElement(RenameReferencesDialog, {
        from: '/notes/old.md',
        to: '/notes/new.md',
        changes,
        onConfirm: confirm,
        onCancel: vi.fn(),
      }),
    ),
  );
  act(() => host.querySelector<HTMLInputElement>('.reference-select-all input')!.click());
  act(() => button('确认并继续').click());
  expect(confirm).toHaveBeenCalledWith([]);
  expect(host.querySelector('.reference-dialog-footer')?.textContent).toContain('0 份文档');
});

it('localizes warnings, shows the selected document diff and blocks dismissal during an update', () => {
  setLanguage('en');
  const cancel = vi.fn();
  act(() =>
    root.render(
      createElement(RenameReferencesDialog, {
        from: '/notes/old.md',
        to: '/notes/new.md',
        changes: changes.slice(0, 2),
        busy: true,
        warnings: [{ path: '/notes/doc0.md', reference: 'old', reason: 'ambiguous-wiki' }],
        onConfirm: vi.fn(),
        onCancel: cancel,
      }),
    ),
  );
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
    'Update file references',
  );
  expect(host.querySelector('.reference-warnings')?.textContent).toContain(
    'Multiple documents share this name',
  );
  expect(host.querySelector('.reference-diff')?.textContent).toContain('[old](new.md)');
  expect(button('Updating…').disabled).toBe(true);
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(cancel).not.toHaveBeenCalled();
});
