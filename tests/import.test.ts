import { describe, expect, it, vi } from 'vitest';
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import {
  decodeImportText,
  importDocument,
  importLimit,
  validateDocx,
} from '../src/lib/importDocument';
import { renderMarkdown } from '../src/lib/markdown';

const bytes = (text: string) => new TextEncoder().encode(text);
describe('document import', () => {
  it('imports text literally without turning Markdown-looking text into formatting', async () => {
    const result = await importDocument({
      name: '笔记.txt',
      bytes: bytes('# 标题\r\n**文字**\n- item'),
    });
    expect(result.name).toBe('笔记.md');
    const html = renderMarkdown(result.content);
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<li>');
    expect(html).toContain('# 标题');
  });
  it('decodes BOM UTF-16 and rejects malformed or binary text', () => {
    expect(decodeImportText(Uint8Array.from([255, 254, 0x2d, 0x4e]))).toBe('中');
    expect(decodeImportText(Uint8Array.from([254, 255, 0x4e, 0x2d]))).toBe('中');
    expect(() => decodeImportText(Uint8Array.from([255, 1, 0]))).toThrow();
    expect(() => decodeImportText(bytes('a\0b'))).toThrow();
  });
  it('converts HTML structure, embeds explicitly authorized local images and retains remote references without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const assets = vi.fn(async () => 'data:image/png;base64,YQ==');
    const result = await importDocument(
      {
        name: '文章.html',
        path: '/writing/文章.html',
        bytes: bytes(
          '<h1>标题</h1><p><strong>重点</strong></p><table><tr><td>名称</td><td>数量</td></tr><tr><td>A</td><td>1</td></tr></table><img src="./assets/p.png" alt="本地图"><img src="https://example.test/image.png"><a href="next.md#标题">下一篇</a><script>alert(1)</script><a href="javascript:alert(1)">恶意链接</a>',
        ),
      },
      assets,
    );
    expect(result.content).toContain('# 标题');
    expect(result.content).toContain('**重点**');
    expect(result.content).toMatch(/\| 名称 \| 数量 \|/);
    expect(result.content).toContain('data:image/png;base64,YQ==');
    expect(result.content).toContain('https://example.test/image.png');
    expect(result.content).toContain('file:///writing/next.md#%E6%A0%87%E9%A2%98');
    expect(result.content).not.toContain('alert(1)');
    expect(assets).toHaveBeenCalledExactlyOnceWith('/writing/文章.html', './assets/p.png');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it('reports missing local images and preserves complex tables as sanitized HTML', async () => {
    const result = await importDocument({
      name: 'report.htm',
      bytes: bytes(
        '<img src="lost.png" alt="说明"><table><tr><td colspan="2">合并</td></tr><tr><td>A</td><td>B</td></tr></table>',
      ),
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.content).toContain('说明');
    expect(result.content).toContain('colspan="2"');
  });
  it('converts a real DOCX with headings, emphasis and tables', async () => {
    const file = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '真实文档', heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ children: [new TextRun({ text: '重点', bold: true })] }),
            new Table({
              rows: [
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph('项目')] }),
                    new TableCell({ children: [new Paragraph('状态')] }),
                  ],
                }),
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph('导入')] }),
                    new TableCell({ children: [new Paragraph('完成')] }),
                  ],
                }),
              ],
            }),
          ],
        },
      ],
    });
    const archive = await Packer.toBuffer(file);
    const result = await importDocument({ name: '测试.docx', bytes: new Uint8Array(archive) });
    expect(result.content).toContain('# 真实文档');
    expect(result.content).toContain('**重点**');
    expect(result.content).toMatch(/\| 项目 \| 状态 \|/);
    expect(result.content).toContain('完成');
  });
  it('rejects unsupported formats, fake archives and oversized input', async () => {
    await expect(importDocument({ name: 'file.pdf', bytes: bytes('x') })).rejects.toThrow(
      'Supported',
    );
    expect(() => validateDocx(bytes('not a ZIP'))).toThrow('valid DOCX');
    await expect(
      importDocument({ name: 'large.txt', bytes: new Uint8Array(importLimit + 1) }),
    ).rejects.toThrow('32 MiB');
  });
});
