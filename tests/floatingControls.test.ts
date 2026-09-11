import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloatingViewControls from '../src/components/FloatingViewControls';
import { setLanguage } from '../src/lib/i18n';
import type { Mode } from '../src/lib/types';

let host: HTMLDivElement;
let root: Root;
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

function render(disabled = false) {
  const modeChange = vi.fn();
  const focusChange = vi.fn();
  function Harness() {
    const [mode, setMode] = useState<Mode>('read');
    const [focus, setFocus] = useState(false);
    return createElement(FloatingViewControls, {
      mode,
      onMode: (next) => {
        modeChange(next);
        setMode(next);
      },
      focus,
      onFocus: () => {
        focusChange();
        setFocus((current) => !current);
      },
      transparency: 15,
      disabled,
    });
  }
  act(() => root.render(createElement(Harness)));
  return { modeChange, focusChange };
}

function button(label: string) {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(found, label).not.toBeNull();
  return found!;
}

function press(key: string) {
  act(() =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

describe('floating reading and editing controls', () => {
  it('switches between each document mode and reports the selected mode', () => {
    const { modeChange, focusChange } = render();
    expect(button('阅读模式').getAttribute('aria-pressed')).toBe('true');
    for (const [label, value] of [
      ['编辑模式', 'live'],
      ['源码模式', 'source'],
      ['阅读模式', 'read'],
    ]) {
      act(() => button(label).click());
      expect(modeChange).toHaveBeenLastCalledWith(value);
      expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1);
      expect(button(label).getAttribute('aria-pressed')).toBe('true');
    }
    expect(focusChange).not.toHaveBeenCalled();
  });

  it('offers one keyboard tab stop and reaches every control with arrow keys', () => {
    render();
    expect(host.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
    act(() => button('阅读模式').focus());
    press('ArrowRight');
    expect(document.activeElement).toBe(button('编辑模式'));
    press('ArrowRight');
    expect(document.activeElement).toBe(button('源码模式'));
    press('End');
    expect(document.activeElement).toBe(button('进入专注模式'));
    press('ArrowRight');
    expect(document.activeElement).toBe(button('阅读模式'));
    press('ArrowLeft');
    expect(document.activeElement).toBe(button('进入专注模式'));
    press('Home');
    expect(document.activeElement).toBe(button('阅读模式'));
    expect(host.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
  });

  it('keeps focus mode available when document mode changes are disabled', () => {
    const { modeChange, focusChange } = render(true);
    expect(button('阅读模式').disabled).toBe(true);
    act(() => button('源码模式').click());
    expect(modeChange).not.toHaveBeenCalled();
    const enter = button('进入专注模式');
    expect(enter.disabled).toBe(false);
    expect(enter.tabIndex).toBe(0);
    act(() => enter.click());
    expect(button('退出专注模式').getAttribute('aria-pressed')).toBe('true');
    act(() => button('退出专注模式').click());
    expect(button('进入专注模式').getAttribute('aria-pressed')).toBe('false');
    expect(focusChange).toHaveBeenCalledTimes(2);
  });

  it('updates accessible labels and tooltips when the interface language changes', () => {
    render();
    act(() => setLanguage('en'));
    expect(host.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'Reading and editing controls',
    );
    expect(button('Reading mode').title).toBe('Reading mode');
    expect(button('Editing mode').title).toBe('Editing mode');
    expect(button('Source mode').title).toBe('Source mode');
    act(() => button('Enter focus mode').click());
    expect(button('Exit focus mode').title).toBe('Exit focus mode');
  });
});
