import { afterEach, describe, expect, it } from 'vitest';
import { sourceBlocks } from '../src/editor/sourceBlocks';
import { findTable, changeTable } from '../src/editor/table';
import { setMarkdownConfiguration } from '../src/lib/markdownParser';

afterEach(() => setMarkdownConfiguration({ flavor: 'gfm', math: true, compatibility: false }));
describe('editor block discovery shares CommonMark source maps', () => {
  it('keeps exact table ranges and excludes fenced and nested table-like text', () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |';
    const prefix =
      '# 标题\n\n```md\n' + table + '\n```\n\n> ' + table.replaceAll('\n', '\n> ') + '\n\n';
    const source = prefix + table + '\n\n末尾';
    const line = prefix.split('\n').length;
    expect(findTable(source, 4)).toBeNull();
    expect(findTable(source, 9)).toBeNull();
    expect(findTable(source, line + 2)).toMatchObject({
      from: prefix.length,
      to: prefix.length + table.length,
      row: 2,
    });
    const change = changeTable(source, line + 2, 4, 'addRow')!;
    expect(source.slice(0, change.from)).toBe(prefix);
    expect(source.slice(change.to)).toBe('\n\n末尾');
  });
  it('discovers math, figures and Mermaid without rendering them during editing', () => {
    const source =
      '$$\nx^2\n$$\n\n<figure><img src="图.png"><figcaption>图注</figcaption></figure>\n\n```mermaid\ngraph LR\nA-->B\n```';
    const blocks = sourceBlocks(source);
    expect(blocks.map((block) => block.type)).toEqual(['block_math', 'html_block', 'fence']);
    expect(blocks.at(-1)?.info).toBe('mermaid');
    for (const block of blocks) expect(source.slice(block.from, block.to)).toBe(block.raw);
  });
  it('follows the selected CommonMark profile without turning literal pipes into tables', () => {
    setMarkdownConfiguration({ flavor: 'commonmark', math: false });
    const source = '| A | B |\n| --- | --- |\n| x | y |';
    expect(findTable(source, 3)).toBeNull();
  });
  it('preserves the last block of a long mixed document across repeated edits', () => {
    const section =
      '## Section\n\nParagraph\n\n| A | B |\n| --- | --- |\n| x | y |\n\n```python\nx = 42\n```\n\n';
    const source = section.repeat(650) + 'END';
    for (const suffix of ['', 'abc', '中文']) {
      const blocks = sourceBlocks(source + suffix);
      expect(blocks.filter((block) => block.type === 'table_open')).toHaveLength(650);
      expect(blocks.at(-1)?.raw).toBe('END' + suffix);
      expect(findTable(source + suffix, source.split('\n').length)).toBeNull();
    }
  });
});
