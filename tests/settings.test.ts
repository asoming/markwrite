import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPanel, { type DefaultAppResult } from '../src/components/SettingsPanel';
import { defaultSettings, readSession, writeSession } from '../src/lib/recovery';
import {
  isTheme,
  resolveTheme,
  themeIsDark,
  themeOptions,
  themeTypography,
} from '../src/lib/themes';
import type { Settings } from '../src/lib/types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});
function renderPanel(
  initial: Partial<Settings> = {},
  request = async (): Promise<DefaultAppResult> => ({ status: 'set' }),
) {
  let latest = { ...defaultSettings, ...initial };
  const close = vi.fn();
  function Harness() {
    const [settings, setSettings] = useState(latest);
    return createElement(SettingsPanel, {
      settings,
      onChange: (next) => {
        latest = next;
        setSettings(next);
      },
      onClose: close,
      onDefaultApp: request,
    });
  }
  act(() => root.render(createElement(Harness)));
  return { settings: () => latest, close };
}
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => (item.getAttribute('aria-label') || item.textContent) === name,
  );
  expect(found, name).toBeDefined();
  return found!;
}
const click = (element: HTMLElement) => act(() => element.click());
function change(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  expect(element, label).not.toBeNull();
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

describe('preferences and theme compatibility', () => {
  it('migrates old preferences to Chinese and reading without losing existing settings', () => {
    localStorage.setItem(
      'markwrite.session.v1',
      JSON.stringify({
        docs: [],
        active: '',
        settings: { theme: 'dark', fontSize: 21, autosave: false },
      }),
    );
    const session = readSession()!;
    expect(session.settings).toMatchObject({
      theme: 'dark',
      fontSize: 21,
      autosave: false,
      language: 'zh-CN',
      defaultMode: 'read',
    });
    writeSession([], '', {
      ...session.settings,
      theme: 'night',
      language: 'en',
      defaultMode: 'source',
    });
    expect(readSession()?.settings).toMatchObject({
      theme: 'night',
      language: 'en',
      defaultMode: 'source',
    });
    localStorage.setItem(
      'markwrite.session.v1',
      JSON.stringify({
        docs: [],
        active: '',
        settings: { theme: 'unknown', language: 'xx', defaultMode: 'invalid' },
      }),
    );
    expect(readSession()?.settings).toMatchObject({
      theme: 'system',
      language: 'zh-CN',
      defaultMode: 'read',
    });
  });
  it('resolves system and Night darkness while keeping named presets distinct', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('newsprint', true)).toBe('newsprint');
    expect(themeIsDark('night')).toBe(true);
    expect(themeIsDark('system', true)).toBe(true);
    expect(themeIsDark('github', true)).toBe(false);
    expect(isTheme('pixyll')).toBe(true);
    expect(isTheme('__proto__')).toBe(false);
    expect(themeTypography('newsprint').serif).toBe(true);
    expect(themeTypography('whitey').serif).toBe(false);
  });
  it('applies all five named palettes through the root used by editor and reader', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new NodeURL('../src/lib/themes.css', import.meta.url), 'utf8');
    document.head.append(style);
    const before = document.documentElement.dataset.theme;
    try {
      for (const id of ['github', 'newsprint', 'night', 'pixyll', 'whitey']) {
        const palette = themeOptions.find((option) => option.id === id)!;
        document.documentElement.dataset.theme = id;
        const applied = getComputedStyle(document.documentElement);
        expect(applied.getPropertyValue('--paper').trim()).toBe(palette.paper);
        expect(applied.getPropertyValue('--ink').trim()).toBe(palette.ink);
        expect(applied.getPropertyValue('--accent').trim()).toBe(palette.accent);
        expect(applied.getPropertyValue('--sidebar').trim()).not.toBe('');
        expect(applied.getPropertyValue('--code').trim()).not.toBe('');
        expect(applied.colorScheme).toBe(id === 'night' ? 'dark' : 'light');
      }
    } finally {
      style.remove();
      if (before === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = before;
    }
  });
});

describe('settings panel interactions', () => {
  it('changes language immediately and preserves settings while navigating and selecting themes', () => {
    const session = renderPanel({
      fontSize: 22,
      bodyFont: 'My Font',
      autosave: false,
      customColors: { paper: '#123456', ink: '#ffffff', accent: '#fedcba' },
    });
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    change('界面语言', 'en');
    expect(host.textContent).toContain('Preferences');
    click(button('Editor'));
    change('Default opening mode', 'live');
    change('Code font name', 'Consolas');
    click(button('Images'));
    change('Image storage', 'embedded');
    click(button('Appearance'));
    click(button('Newsprint'));
    expect(session.settings()).toMatchObject({
      language: 'en',
      defaultMode: 'live',
      theme: 'newsprint',
      serif: true,
      fontSize: 22,
      bodyFont: 'My Font',
      codeFont: 'Consolas',
      autosave: false,
      attachmentMode: 'embedded',
    });
    expect(session.settings().customColors).toBeUndefined();
    expect(button('Newsprint').getAttribute('aria-pressed')).toBe('true');
    click(button('Night'));
    expect(session.settings().theme).toBe('night');
    expect(session.settings().serif).toBe(false);
    expect(button('Restore theme colors').disabled).toBe(true);
    change('Background color', '#192633');
    expect(session.settings().customColors).toMatchObject({
      paper: '#192633',
      ink: '#dce5ee',
      accent: '#8ecbdf',
    });
    click(button('Restore theme colors'));
    expect(session.settings().customColors).toBeUndefined();
  });
  it('keeps autosave, numeric typography, image storage, presets, and reset actionable', () => {
    const session = renderPanel();
    click(button('文件'));
    click(host.querySelector<HTMLInputElement>('input[aria-label="自动保存"]')!);
    expect(session.settings().autosave).toBe(false);
    click(button('编辑器'));
    change('字号', '23');
    change('行高', '2.2');
    change('正文宽度', '1020');
    expect(session.settings()).toMatchObject({ fontSize: 23, lineHeight: 2.2, width: 1020 });
    click(button('长文阅读'));
    expect(session.settings()).toMatchObject({
      fontSize: 19,
      lineHeight: 2,
      width: 720,
      serif: true,
    });
    click(button('通用'));
    click(button('恢复默认设置'));
    expect(session.settings()).toEqual(defaultSettings);
  });
  it('opens system association settings without claiming the default application changed', async () => {
    let finish!: (result: DefaultAppResult) => void;
    const request = vi.fn(
      () =>
        new Promise<DefaultAppResult>((resolve) => {
          finish = resolve;
        }),
    );
    renderPanel({ language: 'en' }, request);
    click(button('Files'));
    click(button('Use Markwrite as the default Markdown app'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(button('Working…').disabled).toBe(true);
    await act(async () => finish({ status: 'settings-opened' }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Select Markwrite');
    expect(host.textContent).not.toContain('Markwrite is the default Markdown app');
  });
  it('shows association failures and does not label an unsuccessful operation as complete', async () => {
    renderPanel({ language: 'en' }, async () => {
      throw new Error('Permission denied');
    });
    click(button('Files'));
    await act(async () => button('Use Markwrite as the default Markdown app').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Permission denied');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('supports category arrow keys, focus wrapping, and Escape without changing preferences', () => {
    const session = renderPanel();
    const general = button('通用');
    expect(document.activeElement).toBe(general);
    act(() =>
      general.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
    );
    expect(document.activeElement).toBe(button('外观'));
    expect(button('外观').getAttribute('aria-selected')).toBe('true');
    act(() =>
      button('外观').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(button('完成'));
    act(() =>
      button('完成').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.settings()).toEqual(defaultSettings);
  });
});
