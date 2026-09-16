import { describe, it, expect } from 'vitest';
import { shortcutIssues, shortcutKey, resolveShortcut, validShortcuts } from '../src/lib/shortcuts';

describe('custom shortcuts', () => {
  it('checks shared and contextual collisions without conflicting reading and editing arrows', () => {
    expect(shortcutIssues({})).toEqual([]);
    expect(shortcutIssues({ 'app:open': 'Mod+S' }).join()).toContain('保存');
    expect(shortcutIssues({ 'format:bold': 'Alt+ArrowUp' }).join()).toContain('段落上移');
    expect(shortcutIssues({ 'app:save': 'S' })).not.toEqual([]);
    expect(validShortcuts({ 'app:save': 'Mod+Shift+Q' })).toEqual({ 'app:save': 'Mod+Shift+Q' });
  });
  it('routes changed bindings and suppresses the previous editor keymap binding', () => {
    const overrides = { 'format:bold': 'Mod+Shift+B' };
    expect(
      resolveShortcut(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }), overrides, 'edit'),
    ).toEqual({ action: undefined, blocked: true });
    expect(
      resolveShortcut(
        new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true }),
        overrides,
        'edit',
      ).action,
    ).toBe('format:bold');
    expect(
      shortcutKey(new KeyboardEvent('keydown', { key: '1', metaKey: true, altKey: true })),
    ).toBe('Mod+Alt+1');
  });
});
it('normalizes shifted digits and punctuation when recording and invoking chords', () => {
  expect(
    shortcutKey(
      new KeyboardEvent('keydown', { key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true }),
    ),
  ).toBe('Mod+Shift+8');
  expect(
    shortcutKey(
      new KeyboardEvent('keydown', { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
    ),
  ).toBe('Mod+Shift+/');
});
it('keeps previous custom chords when new mode defaults collide', () => {
  expect(validShortcuts({ 'app:save': 'Mod+1' })).toEqual({ 'app:save': 'Mod+1', 'view:live': '' });
});
