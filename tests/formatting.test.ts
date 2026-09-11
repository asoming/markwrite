import { describe, expect, it } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import {
  formattingTransaction,
  insertMarkdownTransaction,
  tableMarkdown,
  pasteTableCells,
  clipboardMarkdown,
} from '../src/editor/formatting';
import { renderMarkdown } from '../src/lib/markdown';

function edit(source: string, from: number, to = from) {
  let state = EditorState.create({
    doc: source,
    selection: EditorSelection.range(from, to),
    extensions: [history()],
  });
  return {
    get state() {
      return state;
    },
    format(action: Parameters<typeof formattingTransaction>[1]) {
      const transaction = formattingTransaction(state, action);
      if (transaction) state = state.update(transaction).state;
    },
    undo() {
      undo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      });
    },
    redo() {
      redo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      });
    },
  };
}
describe('visual formatting writes small reversible Markdown transactions', () => {
  it('formats selections across paragraphs and lists into valid independent emphasis', () => {
    const source = '第一段\n\n- 第二段\n- 第三段';
    const editor = edit(source, 0, source.length);
    editor.format('bold');
    expect(editor.state.doc.toString()).toBe('**第一段**\n\n- **第二段**\n- **第三段**');
    const rendered = renderMarkdown(editor.state.doc.toString());
    expect(rendered).toContain('<p><strong>第一段</strong></p>');
    expect(rendered).toContain('<li><strong>第二段</strong></li>');
    editor.undo();
    expect(editor.state.doc.toString()).toBe(source);
  });
  it('keeps selected Chinese text selected and toggles bold without touching other paragraphs', () => {
    const original = '前文\n\n你好世界\n\n<!-- 保留未知语法 -->';
    const editor = edit(original, 4, 8);
    editor.format('bold');
    expect(editor.state.doc.toString()).toBe('前文\n\n**你好世界**\n\n<!-- 保留未知语法 -->');
    expect(
      editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
    ).toBe('你好世界');
    editor.format('bold');
    expect(editor.state.doc.toString()).toBe(original);
    editor.undo();
    expect(editor.state.doc.toString()).toContain('**你好世界**');
    editor.undo();
    expect(editor.state.doc.toString()).toBe(original);
    expect(editor.state.selection.main.from).toBe(4);
    expect(editor.state.selection.main.to).toBe(8);
    editor.redo();
    expect(editor.state.doc.toString()).toContain('**你好世界**');
  });
  it('combines and removes italic inside bold without destroying the bold marks', () => {
    const editor = edit('**你好**', 2, 4);
    editor.format('italic');
    expect(editor.state.doc.toString()).toBe('***你好***');
    editor.format('italic');
    expect(editor.state.doc.toString()).toBe('**你好**');
  });
  it('inserts selected placeholder text at a cursor and preserves reverse selections', () => {
    const empty = edit('', 0);
    empty.format('bold');
    expect(empty.state.doc.toString()).toBe('**文字**');
    const reverse = edit('文字内容', 4, 0);
    reverse.format('strike');
    expect(reverse.state.selection.main.anchor).toBe(6);
    expect(reverse.state.selection.main.head).toBe(2);
  });
  it('escapes embedded code delimiters and renders literal backticks', () => {
    const editor = edit('a`b', 0, 3);
    editor.format('inlineCode');
    expect(editor.state.doc.toString()).toBe('``a`b``');
    expect(renderMarkdown(editor.state.doc.toString())).toContain('<code>a`b</code>');
    editor.format('inlineCode');
    expect(editor.state.doc.toString()).toBe('a`b');
  });
  it('changes only selected heading prefixes and roundtrips to body', () => {
    const editor = edit('# 第一段\n第二段\n第三段', 0, 10);
    editor.format('heading2');
    expect(editor.state.doc.toString()).toBe('## 第一段\n## 第二段\n第三段');
    editor.undo();
    expect(editor.state.doc.toString()).toBe('# 第一段\n第二段\n第三段');
  });
  it('converts and toggles ordered/task lists while preserving indentation', () => {
    const editor = edit('- 第一项\n  - 第二项', 0, 13);
    editor.format('orderedList');
    expect(editor.state.doc.toString()).toBe('1. 第一项\n  2. 第二项');
    editor.format('taskList');
    expect(editor.state.doc.toString()).toBe('- [ ] 第一项\n  - [ ] 第二项');
    editor.format('taskList');
    expect(editor.state.doc.toString()).toBe('第一项\n  第二项');
    editor.undo();
    expect(editor.state.doc.toString()).toBe('- [ ] 第一项\n  - [ ] 第二项');
  });
  it('moves multi-line paragraphs with whitespace and selection retained', () => {
    const editor = edit('第一段\n继续\n\n第二段\n\n第三段', 8, 11);
    editor.format('moveUp');
    expect(editor.state.doc.toString()).toBe('第二段\n\n第一段\n继续\n\n第三段');
    expect(
      editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to),
    ).toBe('第二段');
    editor.format('moveDown');
    expect(editor.state.doc.toString()).toBe('第一段\n继续\n\n第二段\n\n第三段');
  });
  it('does not write to a read-only document', () => {
    const state = EditorState.create({ doc: '原文', extensions: [EditorState.readOnly.of(true)] });
    expect(formattingTransaction(state, 'bold')).toBeNull();
  });
  it('inserts dialog results in one undo step', () => {
    let state = EditorState.create({
      doc: '前后',
      selection: { anchor: 1 },
      extensions: [history()],
    });
    state = state.update(insertMarkdownTransaction(state, '[文档](<./中文 文档.md>)')).state;
    expect(state.doc.toString()).toBe('前[文档](<./中文 文档.md>)后');
    undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    });
    expect(state.doc.toString()).toBe('前后');
  });
});
describe('visual table grid and rich clipboard', () => {
  it('preserves nested ordered lists and literal Markdown-looking pasted text', () => {
    const nested = renderMarkdown(
      clipboardMarkdown('<ol start="10"><li>父级<ul><li>子级</li></ul></li><li>下一项</li></ol>'),
    );
    const host = document.createElement('div');
    host.innerHTML = nested;
    expect(host.querySelector('ol[start="10"] > li > ul > li')?.textContent).toBe('子级');
    const literal = renderMarkdown(clipboardMarkdown('<p># 普通文字</p><p>1. 普通数字</p>'));
    expect(literal).not.toContain('<h1');
    expect(literal).not.toContain('<ol');
    expect(literal).toContain('# 普通文字');
  });
  it('extends a grid for TSV paste, keeps alignment, and escapes literal pipes', () => {
    const pasted = pasteTableCells(
      {
        rows: [
          ['名称', '值'],
          ['原值', ''],
        ],
        alignments: ['left', 'right'],
      },
      1,
      1,
      'a|b\t42\n中文\t0\n',
    );
    expect(pasted.rows).toEqual([
      ['名称', '值', ''],
      ['原值', 'a|b', '42'],
      ['', '中文', '0'],
    ]);
    expect(pasted.alignments).toEqual(['left', 'right', 'none']);
    const markdown = tableMarkdown(pasted);
    expect(markdown).toContain('a\\|b');
    const rendered = renderMarkdown(markdown);
    expect(rendered).toContain('a|b');
    expect(rendered).toContain('align="right"');
  });
  it('converts pasted formatted HTML to editable Markdown instead of dropping styles', () => {
    const converted = clipboardMarkdown(
      '<h2>标题</h2><p>这是<strong>粗体</strong>和<em>斜体</em>。</p><ul><li>第一项</li><li>第二项</li></ul><pre><code>const x = `a`;</code></pre>',
    );
    expect(converted).toContain('## 标题');
    expect(converted).toContain('**粗体**');
    expect(converted).toContain('*斜体*');
    expect(converted).toContain('- 第一项');
    expect(converted).toContain('const x = `a`;');
    const rendered = renderMarkdown(converted);
    expect(rendered).toContain('<strong>粗体</strong>');
    expect(rendered).toContain('<li>第二项</li>');
  });
  it('converts HTML tables and removes active clipboard content', () => {
    const result = clipboardMarkdown(
      '<script>alert(1)</script><p><a href="javascript:alert(1)">危险链接</a></p><table><tr><th>标题</th><th>值</th></tr><tr><td>A|B</td><td><b>粗体</b></td></tr></table>',
    );
    expect(result).not.toContain('javascript:');
    expect(result).not.toContain('alert(1)');
    expect(result).toContain('危险链接');
    expect(result).toContain('A\\|B');
    expect(renderMarkdown(result)).toContain('<strong>粗体</strong>');
  });
});
