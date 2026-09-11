import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  getHeadings,
  normalizeContent,
  serializeContent,
  wordCount,
} from '../src/lib/markdown';
import { readSession, writeSession, defaultSettings } from '../src/lib/recovery';

describe('Markdown fidelity and rendering', () => {
  it('preserves BOM and CRLF on roundtrip', () => {
    const raw = '\uFEFF# 标题\r\n\r\n- 项目  \r\n[ref]: ./中文路径.md\r\n';
    expect(serializeContent(normalizeContent(raw), true, true)).toBe(raw);
  });
  it('creates stable duplicate heading targets and excludes fenced examples', () => {
    const content = '# 开始\n\n```md\n# 不是标题\n```\n\n## 重复\n\n## 重复\n';
    expect(getHeadings(content).map((h) => [h.text, h.line, h.id])).toEqual([
      ['开始', 1, '开始'],
      ['重复', 7, '重复'],
      ['重复', 9, '重复-1'],
    ]);
    expect(renderMarkdown(content)).toContain('id="重复-1"');
  });
  it('renders math without interpreting math inside code', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('数学 $a^2$\n\n```text\n$x$\n```\n');
    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(root.querySelector('pre code')?.textContent).toBe('$x$');
  });
  it('renders tables and retains unknown syntax as text', () => {
    const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[[未支持的双链]]');
    expect(html).toContain('<table>');
    expect(html).toContain('[[未支持的双链]]');
  });
  it('does not execute script or auto-load remote images', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="https://attacker.invalid/pixel" onerror="alert(1)">\n\n[bad](javascript:alert%281%29)',
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('[onerror]')).toBeNull();
    expect(root.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(root.querySelector('a')?.getAttribute('href') || '').not.toMatch(/^javascript:/);
  });
  it('does not resolve remote URLs inside raw HTML styles or SVG', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown(
      '<div style="background:url(https://attacker.invalid/pixel)">x</div><svg><image href="https://attacker.invalid/x"/></svg>',
    );
    expect(root.querySelector('[style]')).toBeNull();
    expect(root.querySelector('image')).toBeNull();
  });
  it('counts mixed Chinese and English text', () => {
    expect(wordCount('今天 write a note 123')).toBe(6);
  });
});
describe('recovery', () => {
  it('restores unsaved content without pretending it reached disk', () => {
    const doc = {
      id: 'test',
      name: 'test.md',
      content: 'unsaved',
      saved: 'old',
      updated: 1,
      bom: false,
      crlf: false,
      status: 'saving' as const,
    };
    writeSession([doc], doc.id, defaultSettings);
    expect(readSession()?.docs[0].content).toBe('unsaved');
    expect(readSession()?.docs[0].status).toBe('dirty');
  });
  it('ignores malformed storage', () => {
    localStorage.setItem('markwrite.session.v1', '{broken');
    expect(readSession()).toBeNull();
  });
});

describe('table operations', () => {
  it('keeps escaped pipes and surrounding paragraphs when adding a column', async () => {
    const { changeTable } = await import('../src/editor/table');
    const source = '# 标题\n\n| A | B |\n| --- | --- |\n| a\\|b | c |\n\n正文';
    const change = changeTable(source, 5, 3, 'addColumn')!;
    const result = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(result).toContain('a\\|b');
    expect(result.startsWith('# 标题\n\n')).toBe(true);
    expect(result.endsWith('\n\n正文')).toBe(true);
    expect(renderMarkdown(result)).toContain('<table>');
  });
  it('protects the last body row and last column', async () => {
    const { changeTable } = await import('../src/editor/table');
    const source = '| A |\n| --- |\n| a |';
    expect(changeTable(source, 3, 3, 'removeRow')).toBeNull();
    expect(changeTable(source, 3, 3, 'removeColumn')).toBeNull();
  });
});

it('retains the Mermaid source hook for deferred rendering', () => {
  const html = renderMarkdown('```mermaid\nflowchart LR\n A[开始] --> B[结束]\n```');
  const root = document.createElement('div');
  root.innerHTML = html;
  expect(
    decodeURIComponent(root.querySelector('.diagram')?.getAttribute('data-diagram') || ''),
  ).toContain('flowchart LR');
});
