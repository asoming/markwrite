import { describe, expect, it } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import {
  buildDocx,
  buildPdf,
  collectExportBlocks,
  pdfDefinition,
  exportPageLayout,
} from '../src/lib/export';
import { renderMarkdown } from '../src/lib/markdown';
import { formulaSvg } from '../src/lib/exportMath';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=';
function article(html: string) {
  const root = document.createElement('article');
  root.innerHTML = html;
  return root;
}
function unzip(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes),
    files = new Map<string, string>();
  // Use the central directory: OOXML ZIP files can use a trailing data descriptor.
  for (let pos = 0; pos + 46 <= buffer.length; pos++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) continue;
    const compression = buffer.readUInt16LE(pos + 10),
      size = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28),
      extraLength = buffer.readUInt16LE(pos + 30),
      commentLength = buffer.readUInt16LE(pos + 32);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLength).toString();
    const local = buffer.readUInt32LE(pos + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + size);
    files.set(name, (compression === 8 ? inflateRawSync(compressed) : compressed).toString());
    pos += 45 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe('offline document exports', () => {
  it('exports editable fractions, scripts, roots and matrices with an explicit image fallback', async () => {
    const blocks = await collectExportBlocks(
      article(
        renderMarkdown(
          '公式 $\\frac{a_1}{\\sqrt{x^2}}$\n\n$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$',
        ),
      ),
    );
    const bytes = await buildDocx(blocks, '公式', {}, async () => png);
    const files = unzip(bytes);
    const xml = files.get('word/document.xml')!;
    expect(xml).toContain('<m:oMath>');
    expect(xml).toContain('<m:f>');
    expect(xml).toContain('<m:rad>');
    expect(xml).toContain('<m:sSub>');
    expect(xml).toContain('<m:m>');
    expect([...files.keys()].some((name) => name.startsWith('word/media/'))).toBe(false);
    const fallback = unzip(
      await buildDocx(blocks, '公式', { equations: 'image' }, async () => png),
    );
    expect(fallback.get('word/document.xml')).not.toContain('<m:oMath>');
    expect([...fallback.keys()].some((name) => name.endsWith('.svg'))).toBe(true);
  });

  it('keeps headings, nested lists, tasks, code whitespace, and table structure', async () => {
    const node = article(
      renderMarkdown(
        '# 中文标题\n\n**粗体** 和 [链接](https://example.com)\n\n- [x] 已完成\n  - 子项\n\n```ts\nconst a = 1;\n  a++;\n```\n\n| 名称 | 数量 |\n| --- | --- |\n| 墨页 | 2 |',
      ),
    );
    const blocks = await collectExportBlocks(node);
    expect(blocks[0]).toMatchObject({
      kind: 'paragraph',
      heading: 1,
      runs: [{ text: '中文标题' }],
    });
    expect(JSON.stringify(blocks)).toContain('https://example.com');
    expect(JSON.stringify(blocks)).toContain('[x] ');
    expect(blocks.some((block) => block.kind === 'paragraph' && block.indent === 2)).toBe(true);
    expect(
      blocks.some(
        (block) =>
          block.kind === 'paragraph' &&
          block.code &&
          block.runs.some((run) => run.kind === 'text' && run.text.includes('\n  a++')),
      ),
    ).toBe(true);
    expect(blocks.at(-1)).toMatchObject({
      kind: 'table',
      header: true,
      rows: [
        [[{ text: '名称', bold: true }], [{ text: '数量', bold: true }]],
        [[{ text: '墨页' }], [{ text: '2' }]],
      ],
    });
  });

  it('refuses to lose unresolved images, invalid formulas, or unfinished diagrams', async () => {
    await expect(
      collectExportBlocks(article('<p><img data-asset="lost.png" alt="草图"></p>')),
    ).rejects.toThrow('草图');
    await expect(
      collectExportBlocks(article('<div data-diagram="graph">graph</div>')),
    ).rejects.toThrow('图表尚未');
    await expect(
      collectExportBlocks(article('<code class="math-error">bad</code>')),
    ).rejects.toThrow('语法错误');
    await expect(
      collectExportBlocks(article('<table><tr><td colspan="2">merge</td></tr></table>')),
    ).rejects.toThrow('合并');
  });

  it('creates self-contained formula paths, with no external font or use references', () => {
    const svg = formulaSvg('\\frac{1}{2} + \\sqrt{x^2 + y^2}', true);
    expect(svg).toContain('<path');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toMatch(/<use|<script|https?:\/\/[^" ]+\.(woff|js)/);
    expect(() => formulaSvg('\\invalidcommand', true)).toThrow('公式无法导出');
    const inlineFormula = formulaSvg('E=mc^2', false);
    expect(inlineFormula).toContain('data-mml-node="msup"');
    expect(inlineFormula).toContain('data-c="3D"');
  });

  it('uses SVG viewBox dimensions for percentage widths', async () => {
    const blocks = await collectExportBlocks(
      article(
        '<svg width="100%" viewBox="0 0 320 80"><rect width="320" height="80" fill="#f0f0f0"/></svg>',
      ),
    );
    expect(blocks).toMatchObject([
      { kind: 'paragraph', runs: [{ kind: 'image', width: 320, height: 80 }] },
    ]);
  });

  it('reports unsupported PDF glyphs instead of silently exporting empty boxes', () => {
    expect(() =>
      pdfDefinition([{ kind: 'paragraph', runs: [{ kind: 'text', text: '你好😀' }] }], '测试'),
    ).toThrow('😀');
  });

  it('preserves explicit image dimensions and derives the missing side from its aspect ratio', async () => {
    const explicit = await collectExportBlocks(
      article(`<p><img src="${png}" width="320" height="160"></p>`),
    );
    expect(explicit).toMatchObject([{ kind: 'paragraph', runs: [{ width: 320, height: 160 }] }]);
    const widthOnly = await collectExportBlocks(article(`<p><img src="${png}" width="240"></p>`));
    expect(widthOnly).toMatchObject([{ kind: 'paragraph', runs: [{ width: 240, height: 240 }] }]);
    const heightOnly = await collectExportBlocks(article(`<p><img src="${png}" height="120"></p>`));
    expect(heightOnly).toMatchObject([{ kind: 'paragraph', runs: [{ width: 120, height: 120 }] }]);
  });

  it('uses requested paper and margins, rejects impossible layouts, and checks added PDF text', () => {
    expect(exportPageLayout({ paper: 'LETTER' })).toMatchObject({ width: 612, height: 792 });
    expect(exportPageLayout({ paper: 'A5' }).width).toBeCloseTo(419.53);
    const margins = { top: 20, right: 18, bottom: 22, left: 24 };
    const definition = pdfDefinition([], 'Title.md', { paper: 'A5', margins, pageNumbers: false });
    expect(definition.pageSize).toBe('A5');
    [24, 20, 18, 22].forEach((value, index) =>
      expect((definition.pageMargins as number[])[index]).toBeCloseTo((value * 72) / 25.4),
    );
    expect(definition.footer).toBeUndefined();
    expect(() => exportPageLayout({ margins: { ...margins, left: 100 } })).toThrow('12–40');
    expect(() => exportPageLayout({ margins: { ...margins, left: NaN } })).toThrow('12–40');
    expect(() => pdfDefinition([], 'Title', { header: '😀' })).toThrow('😀');
    expect(() => pdfDefinition([], 'Title', { cover: true, coverSubtitle: '😀' })).toThrow('😀');
  });

  it('generates real A5 pages with a cover, page-numbered PDF contents and linked DOCX contents', async () => {
    const blocks = await collectExportBlocks(
      article(renderMarkdown('# 第一章\n\n文档正文。\n\n## 第二节\n\n更多正文。')),
    );
    const options = {
      paper: 'A5' as const,
      margins: { top: 20, right: 18, bottom: 22, left: 24 },
      header: '页眉 / Header',
      footer: '页脚 / Footer',
      cover: true,
      coverSubtitle: '封面副标题',
      toc: true,
      language: 'en' as const,
    };
    const fonts = Object.fromEntries(
      ['Regular', 'Bold'].map((weight) => [
        `NotoSansCJKsc-${weight}.otf`,
        readFileSync(resolve(`public/fonts/NotoSansCJKsc-${weight}.otf`)).toString('base64'),
      ]),
    );
    const pdf = await buildPdf(blocks, 'Layout.md', options, fonts);
    const pdfText = Buffer.from(pdf).toString('latin1');
    expect(pdfText).toContain('/MediaBox [0 0 419.53 595.28]');
    expect((pdfText.match(/\/Type \/Page\b/g) || []).length).toBe(3);
    const files = unzip(await buildDocx(blocks, 'Layout.md', options));
    const xml = files.get('word/document.xml')!;
    expect(xml).toContain('封面副标题');
    expect(xml).toContain('Contents');
    expect(xml).toContain('w:anchor="heading_0"');
    expect(xml).toContain('w:name="heading_0"');
    expect(xml).toContain('w:w="8391"');
    expect(xml).toContain('w:h="11906"');
    expect(xml).toContain('w:left="1361"');
    expect(xml).toContain('<w:titlePg');
    expect(
      [...files]
        .filter(([name]) => /^word\/header/.test(name))
        .some(([, xml]) => xml.includes('页眉 / Header')),
    ).toBe(true);
    expect(
      [...files]
        .filter(([name]) => /^word\/footer/.test(name))
        .some(([, xml]) => xml.includes('页脚 / Footer') && xml.includes('NUMPAGES')),
    ).toBe(true);
    const noFooter = unzip(await buildDocx(blocks, 'Plain.md', { pageNumbers: false }));
    expect([...noFooter.keys()].some((name) => /^word\/footer\d/.test(name))).toBe(false);
    if (process.env.MARKWRITE_EXPORT_FIXTURES) {
      mkdirSync(process.env.MARKWRITE_EXPORT_FIXTURES, { recursive: true });
      writeFileSync(resolve(process.env.MARKWRITE_EXPORT_FIXTURES, 'layout-a5.pdf'), pdf);
      writeFileSync(
        resolve(process.env.MARKWRITE_EXPORT_FIXTURES, 'layout-a5.docx'),
        await buildDocx(blocks, 'Layout.md', options),
      );
    }
  }, 30000);

  it('creates actual paginated Chinese PDF and editable OOXML DOCX with vector diagrams', async () => {
    const source =
      '# 墨页导出验证\n\n中文正文、**粗体**、*斜体*和[链接](https://example.com)。\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文字体 | 完整嵌入 |\n| 表格 | 保留结构 |\n\n```ts\nconst answer = 42;\n  console.log(answer);\n```\n\n$$\n\\frac{1}{2} + \\sqrt{x^2+y^2}\n$$\n';
    const node = article(renderMarkdown(source));
    node.insertAdjacentHTML(
      'beforeend',
      '<div><svg xmlns="http://www.w3.org/2000/svg" width="360" height="80" viewBox="0 0 360 80"><rect x="4" y="4" width="145" height="60" fill="#edf1ff" stroke="#4361d9"/><text x="30" y="40" font-family="sans-serif" font-size="18">开始写作</text><path d="M150 34H204l-8 -5m8 5l-8 5" fill="none" stroke="#4361d9"/><rect x="210" y="4" width="145" height="60" fill="#edf1ff" stroke="#4361d9"/><text x="234" y="40" font-family="sans-serif" font-size="18">完成导出</text></svg></div>',
    );
    node.insertAdjacentHTML(
      'beforeend',
      `<p><img alt="墨页图标" src="data:image/png;base64,${readFileSync(resolve('public/assets/app-icon.png')).toString('base64')}"></p>`,
    );
    for (let i = 1; i <= 35; i++)
      node.insertAdjacentHTML(
        'beforeend',
        `<p>第 ${i} 段：中文分页验证，保留可选择文本与段落内容。Markdown source remains editable.</p>`,
      );
    const blocks = await collectExportBlocks(node);
    const fonts = Object.fromEntries(
      ['Regular', 'Bold'].map((weight) => [
        `NotoSansCJKsc-${weight}.otf`,
        readFileSync(resolve(`public/fonts/NotoSansCJKsc-${weight}.otf`)).toString('base64'),
      ]),
    );
    const pdf = await buildPdf(blocks, '墨页导出验证', {}, fonts);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe('%PDF-1.3');
    expect(pdf.length).toBeGreaterThan(10000);
    expect(pdfDefinition(blocks, '测试', { template: 'compact' }).defaultStyle?.fontSize).toBe(10);
    const docx = await buildDocx(blocks, '墨页导出验证', {}, async () => png);
    expect(new TextDecoder().decode(docx.slice(0, 2))).toBe('PK');
    const files = unzip(docx);
    expect(files.get('word/document.xml')).toContain('墨页导出验证');
    expect(files.get('word/document.xml')).toContain('<w:tbl>');
    expect(files.get('word/document.xml')).toContain('<w:cr/>');
    expect(files.get('word/document.xml')).toContain('w:lineRule="auto"');
    expect(files.get('word/_rels/document.xml.rels')).toContain('https://example.com');
    expect([...files.keys()].some((name) => name.endsWith('.svg'))).toBe(true);
    expect([...files.values()].some((content) => content.includes('开始写作'))).toBe(true);
    if (process.env.MARKWRITE_EXPORT_FIXTURES) {
      mkdirSync(process.env.MARKWRITE_EXPORT_FIXTURES, { recursive: true });
      writeFileSync(resolve(process.env.MARKWRITE_EXPORT_FIXTURES, 'export-validation.pdf'), pdf);
      writeFileSync(resolve(process.env.MARKWRITE_EXPORT_FIXTURES, 'export-validation.docx'), docx);
    }
  }, 30000);
});

it('keeps figure captions separate and preserves image/caption alignment in PDF and DOCX', async () => {
  const blocks = await collectExportBlocks(
    article(
      `<figure style="text-align:right"><img src="${png}" width="100" height="80"><figcaption>图一 Figure one</figcaption></figure><p>Following text</p>`,
    ),
  );
  expect(blocks).toHaveLength(3);
  expect(blocks[0]).toMatchObject({ kind: 'paragraph', alignment: 'right' });
  expect(blocks[1]).toMatchObject({
    kind: 'paragraph',
    alignment: 'right',
    runs: [{ kind: 'text', text: '图一 Figure one' }],
  });
  expect(JSON.stringify(pdfDefinition(blocks, 'Figures'))).toContain('"alignment":"right"');
  const xml = unzip(await buildDocx(blocks, 'Figures')).get('word/document.xml')!;
  expect(xml).toContain('<w:jc w:val="right"');
  expect(xml).toContain('图一 Figure one');
});

it('exports consecutive display equations as separate centered paragraphs', async () => {
  const blocks = await collectExportBlocks(
    article(
      renderMarkdown(
        '$$\nx^2\n$$\n\n$$\n\\mathbf{x} + \\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n',
      ),
    ),
  );
  expect(blocks).toHaveLength(2);
  expect(
    blocks.every(
      (block) =>
        block.kind === 'paragraph' && block.alignment === 'center' && block.runs.length === 1,
    ),
  ).toBe(true);
  const xml = unzip(await buildDocx(blocks, 'Equations')).get('word/document.xml')!;
  expect(xml.match(/<m:oMath>/g)).toHaveLength(2);
  expect(xml).toContain('<m:sty m:val="b"');
  expect(xml).toContain('<m:begChr m:val="("');
});
