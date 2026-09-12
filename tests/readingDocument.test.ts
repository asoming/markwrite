import { describe, expect, it } from 'vitest';
import { ReadingDocument } from '../src/lib/readingDocument';

describe('complete Markdown structure in virtual reading blocks', () => {
  it('resolves late reference/footnote definitions and keeps duplicate heading anchors global', () => {
    const source =
      '# 同名\n\n[前文][ref] [^one]\n\n' +
      '普通正文。\n\n'.repeat(150) +
      '# 同名\n\n[ref]: https://example.com\n\n[^one]: 最后的脚注。\n';
    const reading = new ReadingDocument(source);
    expect(reading.chunks.map((chunk) => chunk.html).join('')).toContain(
      'href="https://example.com"',
    );
    expect(reading.blocks.flatMap((block) => block.anchors)).toContain('同名-1');
    const footnote = reading.chunks.find((chunk) => chunk.html.includes('最后的脚注'))!;
    expect(footnote).toBeTruthy();
    expect(reading.search('普通正文').total).toBe(150);
    expect(reading.search('最后的脚注').hit?.block).toBe(footnote.index);
  });
  it('retains raw HTML wrappers which begin before a separately tokenized paragraph', () => {
    const reading = new ReadingDocument(
      '<div class="container">\n\n**内部段落**\n\n</div>\n\n结束。',
    );
    const container = document.createElement('div');
    for (const chunk of reading.chunks) {
      const wrapper = document.createElement('section');
      wrapper.innerHTML = chunk.html;
      container.append(wrapper);
    }
    expect(container.querySelector('.container strong')?.textContent).toBe('内部段落');
    expect(container.textContent).toContain('结束。');
  });
  it('batches long tables without losing cells or counting repeated headers as search hits', () => {
    const reading = new ReadingDocument(
      '| 名称 | 值 |\n| --- | --- |\n' +
        Array.from({ length: 300 }, (_, index) => `| 行${index} | **值${index}** |`).join('\n'),
    );
    expect(reading.blocks.length).toBeGreaterThan(5);
    const cells = reading.chunks.flatMap((chunk) => {
      const node = document.createElement('div');
      node.innerHTML = chunk.html;
      return [...node.querySelectorAll('tbody td')].map((cell) => cell.textContent);
    });
    expect(cells).toHaveLength(600);
    expect(cells[599]).toBe('值299');
    expect(reading.search('名称').total).toBe(1);
    expect(reading.blocks.at(-1)?.fromLine).toBe(291);
  });
  it('batches complete ordered-list items and retains the sequence and nested children', () => {
    const reading = new ReadingDocument(
      Array.from(
        { length: 150 },
        (_, index) =>
          `${index + 3}. 第${index}项\n${' '.repeat(String(index + 3).length + 2)}- 内嵌子项${index}\n`,
      ).join('\n'),
    );
    expect(reading.blocks).toHaveLength(4);
    const node = document.createElement('div');
    node.innerHTML = reading.chunks[1].html;
    expect(node.querySelector('ol')?.getAttribute('start')).toBe('51');
    expect(node.querySelectorAll(':scope > ol > li')).toHaveLength(48);
    expect(node.querySelectorAll('ul li')).toHaveLength(48);
    expect(reading.search('内嵌子项').total).toBe(150);
  });
});
