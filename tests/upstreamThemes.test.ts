import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { themeDefaults, themeOptions, themeTypography } from '../src/lib/themes';

const themeCss = readFileSync(new NodeURL('../src/lib/themes.css', import.meta.url), 'utf8');
const fontCss = readFileSync(new NodeURL('../src/lib/themeFonts.css', import.meta.url), 'utf8');
let host: HTMLDivElement;
let style: HTMLStyleElement;
let previousTheme: string | undefined;
beforeEach(() => {
  previousTheme = document.documentElement.dataset.theme;
  style = document.createElement('style');
  style.textContent = themeCss;
  document.head.append(style);
  host = document.createElement('div');
  host.innerHTML = `<article class="markdown-body"><h1>Heading</h1><h2>Section</h2><h3>Detail</h3><p>Text</p><blockquote><p>Quote</p></blockquote><ul><li>One</li></ul><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table></article><div class="editor-host"><div class="cm-heading cm-h1">Heading</div><div class="cm-heading cm-h2">Section</div><div class="cm-quote-line">Quote</div></div><div class="editor-host source-mode"><div class="cm-h1"># Literal heading</div></div><div role="dialog"><h1>Preferences</h1><button>Save</button></div>`;
  document.body.append(host);
});
afterEach(() => {
  style.remove();
  host.remove();
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
});
function computed(selector: string) {
  return getComputedStyle(host.querySelector(selector)!);
}

describe('reference theme typography adapters', () => {
  it('uses distinct reference metrics and local font families, including serif Whitey', () => {
    expect(themeDefaults('github')).toMatchObject({ fontSize: 16, lineHeight: 1.6, width: 860 });
    expect(themeDefaults('newsprint')).toMatchObject({ fontSize: 16, lineHeight: 1.5, width: 640 });
    expect(themeDefaults('night')).toMatchObject({ fontSize: 16, lineHeight: 1.625, width: 914 });
    expect(themeDefaults('pixyll')).toMatchObject({ fontSize: 20, lineHeight: 1.8, width: 914 });
    expect(themeDefaults('whitey')).toMatchObject({
      fontSize: 19,
      lineHeight: 1.53,
      width: 960,
      serif: true,
    });
    expect(themeDefaults('system')).toMatchObject({ fontSize: 17, lineHeight: 1.9, width: 760 });
    for (const [theme, font] of [
      ['github', 'Open Sans'],
      ['newsprint', 'PT Serif'],
      ['pixyll', 'Merriweather'],
      ['whitey', 'Vollkorn'],
    ] as const) {
      expect(themeTypography(theme).bodyFont).toContain(font);
    }
  });
  it('applies GitHub heading rules to reader and live editor while leaving dialogs/source alone', () => {
    document.documentElement.dataset.theme = 'github';
    expect(computed('article h1').borderBottomWidth).toBe('1px');
    expect(computed('.editor-host:not(.source-mode) .cm-h1').borderBottomWidth).toBe('1px');
    expect(computed('article h2').borderBottomColor).toBe('rgb(238, 238, 238)');
    expect(computed('[role="dialog"] h1').borderBottomWidth).not.toBe('1px');
    expect(computed('.source-mode .cm-h1').borderBottomWidth).not.toBe('1px');
  });
  it('gives Whitey centered serif headings, an italic third level and square lists in both surfaces', () => {
    document.documentElement.dataset.theme = 'whitey';
    expect(computed('article h1').textAlign).toBe('center');
    expect(computed('.editor-host:not(.source-mode) .cm-h1').textAlign).toBe('center');
    expect(computed('article h3').fontStyle).toBe('italic');
    expect(computed('article h2').backgroundSize).toBe('100px 1px');
    expect(computed('article ul').listStyleType).toBe('square');
    expect(computed('[role="dialog"] h1').textAlign).not.toBe('center');
  });
  it('keeps Pixyll quotation, table and font treatment distinct from Newsprint and Night', () => {
    document.documentElement.dataset.theme = 'pixyll';
    expect(computed('article blockquote').fontStyle).toBe('italic');
    expect(computed('.cm-quote-line').fontStyle).toBe('italic');
    expect(computed('article th').borderBottomWidth).toBe('2px');
    expect(computed('article th').borderLeftWidth).toBe('0px');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--theme-heading-font'),
    ).toContain('Lato');
    document.documentElement.dataset.theme = 'newsprint';
    expect(computed('article th').textTransform).toBe('uppercase');
    document.documentElement.dataset.theme = 'night';
    expect(computed('article h1').fontWeight).toBe('400');
    expect(computed('article h2').letterSpacing).toBe('-1px');
    expect(getComputedStyle(document.documentElement).colorScheme).toBe('dark');
  });
  it('ships every referenced font locally with source notices and separate font licenses', () => {
    const urls = [...fontCss.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThanOrEqual(16);
    for (const url of urls) {
      expect(url.startsWith('/themes/')).toBe(true);
      expect(existsSync(new NodeURL(`../public${url}`, import.meta.url)), url).toBe(true);
    }
    expect(fontCss).not.toMatch(/https?:\/\/|@import/);
    for (const path of [
      'NOTICE.txt',
      'github/Apache-2.0.txt',
      'newsprint/OFL.txt',
      'pixyll/LICENSE.txt',
      'pixyll/Merriweather-OFL.txt',
      'pixyll/Lato-OFL.txt',
      'whitey/OFL.txt',
    ]) {
      expect(existsSync(new NodeURL(`../public/themes/${path}`, import.meta.url)), path).toBe(true);
    }
    for (const theme of themeOptions.filter((option) =>
      ['github', 'newsprint', 'night', 'pixyll', 'whitey'].includes(option.id),
    )) {
      document.documentElement.dataset.theme = theme.id;
      expect(getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()).toBe(
        theme.paper,
      );
    }
  });
});
