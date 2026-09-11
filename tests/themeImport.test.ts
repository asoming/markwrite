import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileDocumentTheme,
  createImportedTheme,
  emptyThemeLibrary,
  loadThemeLibrary,
  maxThemeBytes,
  resetThemeLibrary,
  saveThemeLibrary,
  themeLibraryEvent,
  themeLibraryKey,
  ThemeImportError,
} from '../src/lib/themeImport';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
const compile = (css: string) => compileDocumentTheme(css, 'test-theme');

describe('imported document CSS', () => {
  it('adapts Typora document roots and common headings, code and paragraph selectors to scoped reader and live editor rules', () => {
    const result = compile(`
      :root { --text-color: #193344; }
      html body #write { font: 18px Georgia; max-width: 780px; color: var(--text-color); }
      #write h1, body h2 { color: #125678; margin-top: 24px; }
      #write p code { color: #763321; }
      .md-fences { background: #eff1f2; }
      @media (max-width: 800px) { #write { padding: 18px; } }
    `);
    expect(result.rules).toBe(6);
    expect(result.css).toContain('[data-custom-document-theme] .reader.markdown-body h1');
    expect(result.css).toContain('.editor-host:not(.source-mode) .cm-content .cm-h1');
    expect(result.css).toContain('.cm-content .cm-line .cm-rich-inlinecode');
    expect(result.css).toContain('.reader.markdown-body pre');
    expect(result.css).toContain('.cm-content .cm-code-line');
    expect(result.css).toContain('@media (max-width: 800px)');
    expect(result.css).not.toContain('#write');
    expect(result.notices).toEqual([]);
  });

  it('keeps every selector inside the document, including nested pseudo selector lists and attempts to target app chrome', () => {
    const result = compile(`
      #write h1, .settings-dialog, #app, body .sidebar { color: red; }
      #write + .compact-header { color: pink; }
      html ~ #app { color: cyan; }
      :is(.paragraph, body) { color: orange; }
      #write:has(+ .settings-dialog) { color: purple; }
      p:not(.muted), li:nth-child(2n + 1) { color: blue; }
    `);
    expect(result.css).toContain('.reader.markdown-body .settings-dialog');
    expect(result.css).not.toContain('.compact-header');
    expect(result.css).not.toContain('~ #app');
    expect(result.css).not.toContain(':is(.paragraph, body)');
    expect(result.css).not.toContain(':has');
    expect(result.css).toContain('.reader.markdown-body p:not(.muted)');
    expect(result.notices).toContain('selectors');
  });

  it('blocks imports, external and escaped URLs, script-like values, layout escape and generated content', () => {
    const result = compile(String.raw`
      @import "https://tracker.test/style.css";
      @keyframes bad { to { opacity: 0; } }
      #write {
        color: #123456; background-image: url(https://tracker.test/pixel);
        --external: u\72l("https://tracker.test/escaped.png");
        background: image-set("https://tracker.test/image" 1x);
        border-color: expression(alert(1));
        behavior: url(evil.htc); -moz-binding: url(evil.xml);
        position: fixed; inset: 0; z-index: 999999; transform: translate(0, -100vh);
        margin-top: -1000px; text-indent: calc(-1 * 100vw);
      }
      #write::before { content: "Fake settings"; color: red; }
    `);
    expect(result.css).not.toMatch(
      /https:|tracker|@import|@keyframes|expression|binding|behavior|image-set|Fake settings/,
    );
    expect(result.css).not.toMatch(
      /position:\s*fixed|inset:|z-index:|transform:|margin-top:|text-indent:/,
    );
    expect(result.css).toContain('contain: paint !important');
    expect(result.notices).toEqual(expect.arrayContaining(['at-rules', 'resources', 'properties']));
  });

  it('retains embedded raster images, rejects SVG and relative files, and isolates bundled font names', () => {
    const result = compile(`
      @font-face { font-family: "App Font"; src: url("data:font/woff2;base64,d09GMg==") format("woff2"); font-weight: 400; }
      @font-face { font-family: Bad; src: url("fonts/bad.woff2"); }
      #write { font-family: "App Font", serif; background-image: url("data:image/png;base64,aGVsbG8="); }
      h1 { background-image: url("data:image/svg+xml;base64,PHN2Zz4="); }
      h2 { background-image: url("./picture.png"); }
    `);
    expect(result.css).toContain('data:font/woff2;base64,d09GMg==');
    expect(result.css).toContain('font-family: "mw-theme-test-theme-0"');
    expect(result.css).toContain('data:image/png;base64,aGVsbG8=');
    expect(result.css).not.toContain('font-family: "App Font"');
    expect(result.css).not.toContain('data:image/svg');
    expect(result.css).not.toContain('fonts/bad');
    expect(result.css).not.toContain('./picture');
    expect(result.notices).toContain('resources');
  });

  it('does not accept escaped at-rule names as a way to import CSS or register global fonts', () => {
    for (const source of [
      String.raw`@\69mport url(https://tracker.test/escaped.css); body {color:red}`,
      String.raw`@\66ont-face { font-\66amily: "Markwrite Sans"; src: local("Arial"); } body {font-family: "Markwrite Sans";}`,
    ]) {
      // PostCSS currently rejects these escaped at-rule names before they reach
      // the sanitizer. If it accepts them in a later version, scoping must hold.
      try {
        const result = compile(source);
        expect(result.css).not.toMatch(/tracker|@import|font-family:\s*"Markwrite Sans"/);
      } catch (error) {
        expect(error).toBeInstanceOf(ThemeImportError);
        expect(error).toMatchObject({ code: 'syntax' });
      }
    }
  });

  it('scopes previews independently from applied themes', () => {
    const result = compileDocumentTheme(
      'body {color: red} h1 {font-size: 32px}',
      'preview-one',
      true,
    );
    expect(result.css).toContain('[data-theme-preview="preview-one"] .theme-preview-document h1');
    expect(result.css).not.toContain('[data-custom-document-theme]');
    expect(result.css).not.toContain('.cm-content');
  });

  it('rejects malformed, oversized and entirely unsupported CSS with actionable error codes', () => {
    for (const [css, code] of [
      ['h1 { color: "unterminated; }', 'syntax'],
      ['/*' + 'a'.repeat(maxThemeBytes) + '*/', 'size'],
      ['@import "https://example.com/theme.css";', 'empty'],
    ]) {
      try {
        compile(css);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(ThemeImportError);
        expect(error).toMatchObject({ code });
      }
    }
  });
});

describe('theme library persistence', () => {
  it('preserves original CSS and names across reload, deactivate and reset without changing application preferences', () => {
    localStorage.setItem('markwrite.session.v1', 'existing document session');
    const theme = createImportedTheme('  My local theme  ', 'body {color: #321123;}');
    const listener = vi.fn();
    window.addEventListener(themeLibraryEvent, listener);
    try {
      saveThemeLibrary({ version: 1, themes: [theme], activeId: theme.id });
      expect(loadThemeLibrary()).toEqual({ version: 1, themes: [theme], activeId: theme.id });
      expect(theme.name).toBe('My local theme');
      saveThemeLibrary({ ...loadThemeLibrary(), activeId: null });
      expect(loadThemeLibrary().themes).toHaveLength(1);
      expect(loadThemeLibrary().activeId).toBeNull();
      resetThemeLibrary();
      expect(loadThemeLibrary()).toEqual(emptyThemeLibrary());
      expect(listener).toHaveBeenCalledTimes(3);
      expect(localStorage.getItem('markwrite.session.v1')).toBe('existing document session');
    } finally {
      window.removeEventListener(themeLibraryEvent, listener);
    }
  });

  it('does not report an apply event or replace saved themes when storage fails', () => {
    const theme = createImportedTheme('Existing', 'h1 {color: blue}');
    saveThemeLibrary({ version: 1, themes: [theme], activeId: theme.id });
    const before = localStorage.getItem(themeLibraryKey);
    const listener = vi.fn();
    window.addEventListener(themeLibraryEvent, listener);
    try {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('Full', 'QuotaExceededError');
      });
      expect(() => saveThemeLibrary({ version: 1, themes: [], activeId: null })).toThrow();
      expect(listener).not.toHaveBeenCalled();
      expect(localStorage.getItem(themeLibraryKey)).toBe(before);
    } finally {
      window.removeEventListener(themeLibraryEvent, listener);
    }
  });

  it('rejects malformed saved libraries and unsafe scope IDs instead of injecting them', () => {
    for (const value of [
      '{broken',
      JSON.stringify({ version: 1, themes: [], activeId: 'missing' }),
      JSON.stringify({
        version: 1,
        themes: [{ id: '"] body, /*', name: 'Bad', css: 'body{color:red}', createdAt: 1 }],
        activeId: null,
      }),
    ]) {
      localStorage.setItem(themeLibraryKey, value);
      expect(loadThemeLibrary).toThrow(ThemeImportError);
    }
    expect(() => compileDocumentTheme('body{color:red}', '"], body, [x="')).toThrow(
      ThemeImportError,
    );
  });
});
