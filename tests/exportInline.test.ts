import { describe, expect, it } from 'vitest';
import { inlineFormulaLines } from '../src/lib/exportInline';
import { collectExportBlocks, pdfDefinition } from '../src/lib/export';
import { renderMarkdown } from '../src/lib/markdown';
const metrics = { width: (text: string) => text.length * 6, ascent: 1, descent: 0.25 };
describe('inline formula PDF layout', () => {
  it('retains one baseline, selectable text and vector math rather than separate block images', async () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown('Before $x^2$ after.');
    const blocks = await collectExportBlocks(root);
    expect(blocks[0].kind).toBe('paragraph');
    if (blocks[0].kind !== 'paragraph') return;
    expect(blocks[0].runs.find((run) => run.kind === 'image')).toMatchObject({ inline: true });
    const lines = inlineFormulaLines(blocks[0].runs, 400, { size: 12, lineHeight: 1.4, metrics });
    expect(lines).toHaveLength(1);
    const svg = new DOMParser().parseFromString((lines[0] as { svg: string }).svg, 'image/svg+xml');
    expect(svg.querySelectorAll('parsererror')).toHaveLength(0);
    expect(svg.documentElement.textContent).toBe('Before  after.');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(
      new Set([...svg.querySelectorAll('text')].map((node) => node.getAttribute('y'))).size,
    ).toBe(1);
    const definition = pdfDefinition(blocks, 'Inline');
    expect(JSON.stringify(definition)).toContain('<text');
  });
  it('wraps long mixed paragraphs into separately paginatable lines and retains styles', async () => {
    const root = document.createElement('article');
    root.innerHTML = renderMarkdown('A **bold** $a+b$ ' + '中文内容 longword '.repeat(40));
    const blocks = await collectExportBlocks(root);
    if (blocks[0].kind !== 'paragraph') throw new Error('missing paragraph');
    const lines = inlineFormulaLines(blocks[0].runs, 120, { size: 12, lineHeight: 1.5, metrics });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.every((line) => (line as { width: number }).width === 120)).toBe(true);
    const html = lines.map((line) => (line as { svg: string }).svg).join('');
    expect(html).toContain('font-weight="bold"');
    const parsed = new DOMParser().parseFromString(`<root>${html}</root>`, 'application/xml');
    expect(parsed.documentElement.textContent?.match(/中文内容/g)?.length).toBe(40);
  });
});
