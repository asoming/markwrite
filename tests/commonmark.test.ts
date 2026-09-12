// CommonMark 0.31.2 examples are provided by the official commonmark-spec package.
// https://github.com/commonmark/commonmark-spec (CC BY-SA 4.0). The spec uses → for tabs.
import { describe, expect, it } from 'vitest';
import { tests } from 'commonmark-spec';
import {
  createMarkdownParser,
  renderMarkdownBlocks,
  renderMarkdownRaw,
  md,
} from '../src/lib/markdownParser';
import {
  renderMarkdown,
  sanitizeRenderedMarkdown,
  configureMarkdown,
  configureInlineSyntax,
  getHeadings,
} from '../src/lib/markdown';
import { starterExtension } from '../src/lib/extensions';

describe('official CommonMark 0.31.2 fixtures, with optional extensions disabled', () => {
  const parser = createMarkdownParser({
    flavor: 'commonmark',
    math: false,
    footnotes: false,
    presentation: false,
  });
  for (const fixture of tests)
    it(`${fixture.number}: ${fixture.section}`, () => {
      expect(parser.render(fixture.markdown.replaceAll('→', '\t'))).toBe(
        fixture.html.replaceAll('→', '\t'),
      );
    });
});
describe('shared Markdown document parsing', () => {
  it('resolves references once and gives exact source coordinates after definitions', () => {
    const source = '[ref]: ../中文.md "title"\n\n# A &amp; B\n\n[link][ref]\n\n# A & B\n';
    const blocks = [...renderMarkdownBlocks(source)];
    expect(blocks.map((block) => [block.fromLine, block.toLine])).toEqual([
      [3, 4],
      [5, 6],
      [7, 8],
    ]);
    expect(blocks.map((block) => block.raw)).toEqual([
      '# A &amp; B\n',
      '[link][ref]\n',
      '# A & B\n',
    ]);
    expect(blocks[1].html).toContain('href="../%E4%B8%AD%E6%96%87.md"');
    expect(blocks.flatMap((block) => block.headingIds)).toEqual(['a-b', 'a-b-1']);
    expect(blocks.map((block) => block.html).join('')).toBe(renderMarkdownRaw(source));
    expect(getHeadings(source).map((heading) => [heading.id, heading.line])).toEqual([
      ['a-b', 3],
      ['a-b-1', 7],
    ]);
    const sanitized = blocks
      .map((block) => sanitizeRenderedMarkdown(block.html, { preserveHeadingIds: true }))
      .join('');
    expect(sanitized).toContain('id="a-b-1"');
  });
  it('keeps footnotes at the document end with repeat backlinks and correct definition lines', () => {
    const source =
      '# Notes\n\nFirst[^note] and again[^note].\n\n[^note]: Footnote **中文**.\n\n    Continued paragraph.\n\nLast paragraph.\n';
    const blocks = [...renderMarkdownBlocks(source)];
    expect(blocks.at(-1)?.html).toContain('class="footnotes"');
    expect(blocks.at(-1)?.html).toContain('Footnote <strong>中文</strong>');
    expect(blocks.at(-1)?.html).toContain('Continued paragraph.');
    expect(blocks.at(-1)?.html).toContain('href="#fnref1:1"');
    expect(blocks.at(-1)?.fromLine).toBe(5);
    expect(blocks.map((block) => block.html).join('')).toBe(renderMarkdownRaw(source));
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(source);
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'))
      expect(root.querySelector(`[id="${anchor.getAttribute('href')!.slice(1)}"]`)).not.toBeNull();
  });
  it('never enables wiki/custom/inline-footnote syntax without compatibility mode', () => {
    const source = '[[target|Label]] ==Highlight== ^[custom note]';
    configureInlineSyntax([starterExtension]);
    configureMarkdown({ compatibility: false });
    expect(renderMarkdown(source)).toContain('[[target|Label]] ==Highlight== ^[custom note]');
    expect(md.lexer(source).some((token) => JSON.stringify(token).includes('wikiLink'))).toBe(
      false,
    );
    expect(renderMarkdown(source, { compatibility: true })).toContain('class="wiki-link"');
    expect(renderMarkdown(source, { compatibility: true })).toContain('class="syntax-highlight"');
    expect(source).toBe('[[target|Label]] ==Highlight== ^[custom note]');
    configureInlineSyntax([]);
  });
  it('renders GFM tasks, tables, strike and preserves math/code distinctions', () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(
      '- [x] Done\n- [ ] Todo\n\n| A | B |\n| --- | --- |\n| ~~old~~ | $x$ |\n\n```md\n[^note]: $literal$\n```\n',
    );
    expect(root.querySelectorAll('.task-check')).toHaveLength(2);
    expect(root.querySelectorAll('.task-check.checked')).toHaveLength(1);
    expect(root.querySelector('s')?.textContent).toBe('old');
    expect(root.querySelectorAll('.math-rendered')).toHaveLength(1);
    expect(root.querySelector('pre')?.textContent).toBe('[^note]: $literal$');
  });
  it('keeps supported embedded raster images while refusing SVG data URLs', () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(
      '![avif](data:image/avif;base64,AAAA) ![bmp](data:image/bmp;base64,AAAA) ![bad](data:image/svg+xml;base64,AAAA)',
    );
    expect(root.querySelectorAll('img')).toHaveLength(2);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/avif;base64,AAAA');
  });
  it('keeps raw HTML wrappers that cross Markdown blocks intact during virtual rendering', () => {
    const source = '<div class="wrapper">\n\n# Inside\n\nContent **bold**.\n\n</div>\n\nOutside.\n';
    const blocks = [...renderMarkdownBlocks(source)];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].fromLine).toBe(1);
    expect(blocks[0].headingIds).toEqual(['inside']);
    const root = document.createElement('article');
    root.innerHTML = blocks
      .map((block) => sanitizeRenderedMarkdown(block.html, { preserveHeadingIds: true }))
      .join('');
    expect(root.querySelector('.wrapper h1')?.textContent).toBe('Inside');
    expect(root.querySelector('.wrapper strong')?.textContent).toBe('bold');
    expect(blocks.map((block) => block.html).join('')).toBe(renderMarkdownRaw(source));
  });
  it('does not let HTML slash attribute separators bypass raw style and SVG filtering', () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(
      '<table background="https://bad.invalid/pixel"><tr><td>cell</td></tr></table>\n\n<div/style="background:url(https://bad.invalid)">text</div>\n\n<svg/onload="alert(1)"><image/href="https://bad.invalid/pixel" /></svg>',
    );
    expect(root.querySelector('[style],svg,image,[onload],[background]')).toBeNull();
  });
  it('preserves ordinary raw HTML inline structure while stripping author styles and active content', () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown(
      'A <b title="quoted > text" style="background:url(https://bad.invalid)">bold</b> and <i>italic</i>.\n\n<svg><image href="https://bad.invalid" /></svg><img src=x onerror=alert(1)>',
    );
    expect(root.querySelector('b')?.textContent).toBe('bold');
    expect(root.querySelector('i')?.textContent).toBe('italic');
    expect(root.querySelector('[style],[onerror],svg,image')).toBeNull();
  });
});
