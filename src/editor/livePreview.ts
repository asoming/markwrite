import {
  StateField,
  Facet,
  StateEffect,
  RangeSetBuilder,
  type EditorState,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { md, renderMarkdown, hydrateDiagrams } from '../lib/markdown';
import { assetData } from '../lib/platform';
import katex from 'katex';
import { inlineSyntaxRules, inlineMatch, syntaxInk } from '../lib/syntax';

export const liveMode = Facet.define<boolean, boolean>({ combine: (values) => values[0] ?? true });
export const documentPath = Facet.define<string, string>({ combine: (values) => values[0] || '' });
export const compositionState = StateEffect.define<boolean>();
export const syntaxChanged = StateEffect.define<null>();
const composing = StateField.define({
  create: () => false,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(compositionState)) v = e.value;
    return v;
  },
});

class TaskCheckbox extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly position: number,
  ) {
    super();
  }
  eq(other: TaskCheckbox) {
    return this.checked === other.checked && this.position === other.position;
  }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    input.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('change', () => {
      view.dispatch({
        changes: {
          from: this.position + 1,
          to: this.position + 2,
          insert: this.checked ? ' ' : 'x',
        },
        userEvent: 'input',
      });
      view.focus();
    });
    return input;
  }
  ignoreEvent() {
    return true;
  }
}
class Bullet extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '•';
    return span;
  }
}
class InlineMath extends WidgetType {
  constructor(
    readonly formula: string,
    readonly position: number,
  ) {
    super();
  }
  eq(other: InlineMath) {
    return this.formula === other.formula && this.position === other.position;
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = 'cm-inline-math';
    span.title = '点击编辑公式';
    span.setAttribute('aria-label', `公式 ${this.formula}`);
    try {
      span.innerHTML = katex.renderToString(this.formula, {
        displayMode: false,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      span.classList.add('math-error');
      span.textContent = this.formula;
      span.title = '公式语法有误，点击修改';
    }
    span.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.position + 1 }, scrollIntoView: true });
      view.focus();
    });
    return span;
  }
  ignoreEvent() {
    return true;
  }
}
class RenderedBlock extends WidgetType {
  constructor(
    readonly raw: string,
    readonly path: string,
    readonly position: number,
  ) {
    super();
  }
  eq(other: RenderedBlock) {
    return this.raw === other.raw && this.path === other.path && this.position === other.position;
  }
  toDOM(view: EditorView) {
    const element = document.createElement('div');
    element.className = 'live-block markdown-body';
    element.innerHTML = renderMarkdown(this.raw);
    element.title = '点击编辑 Markdown 源码';
    if (element.querySelector('table')) {
      const tools = document.createElement('div');
      tools.className = 'live-block-tools';
      const button = document.createElement('button');
      button.textContent = '编辑表格';
      button.type = 'button';
      button.title = '在表格窗口直接编辑单元格';
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () =>
        view.dom.dispatchEvent(
          new CustomEvent('markwrite:edit-table', {
            detail: { from: this.position, to: this.position + this.raw.length },
            bubbles: true,
          }),
        ),
      );
      tools.appendChild(button);
      element.prepend(tools);
    }
    element.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a,button')) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.position }, scrollIntoView: true });
      view.focus();
    });
    element.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      view.dom.dispatchEvent(
        new CustomEvent('markwrite:follow-link', {
          detail: anchor.getAttribute('href') || '',
          bubbles: true,
        }),
      );
    });
    void hydrateDiagrams(element).then(() => view.requestMeasure());
    for (const image of element.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
      const source = image.dataset.asset || '';
      if (/^https?:\/\//i.test(source)) {
        let url: URL;
        try {
          url = new URL(source);
        } catch {
          image.title = '网络图片地址无效，点击正文检查链接';
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'remote-image-load';
        button.textContent = `加载网络图片（将访问 ${url.hostname}）`;
        button.addEventListener('click', () => {
          image.referrerPolicy = 'no-referrer';
          image.onload = () => {
            image.classList.remove('pending-image');
            button.remove();
            view.requestMeasure();
          };
          image.onerror = () => {
            button.textContent = '图片加载失败，点击重试';
            view.requestMeasure();
          };
          image.src = url.href;
        });
        image.after(button);
        continue;
      }
      if (!this.path) continue;
      void assetData(this.path, image.dataset.asset!)
        .then((src) => {
          image.src = src;
          image.classList.remove('pending-image');
          image.onload = () => view.requestMeasure();
        })
        .catch(() => {
          image.title = '图片不可用，点击检查路径';
        });
    }
    return element;
  }
  ignoreEvent() {
    return true;
  }
}
function build(state: EditorState): DecorationSet {
  if (!state.facet(liveMode) || state.field(composing) || state.doc.length > 300_000)
    return Decoration.none;
  const selected = state.selection.ranges.map((r) => ({
    from: state.doc.lineAt(r.from).from,
    to: state.doc.lineAt(r.to).to,
  }));
  const active = (from: number, to: number) => selected.some((r) => from <= r.to && to >= r.from);
  const entries: { from: number; to: number; deco: Decoration }[] = [];
  const blocks: { from: number; to: number }[] = [];
  const mathExcluded: { from: number; to: number }[] = [];
  const add = (from: number, to: number, deco: Decoration) => {
    if (from <= to) entries.push({ from, to, deco });
  };
  let offset = 0;
  for (const t of md.lexer(state.doc.toString())) {
    const from = offset;
    offset += t.raw.length;
    const raw = t.raw.replace(/\n+$/, '');
    const to = from + raw.length;
    if (['code', 'blockMath', 'html'].includes(t.type)) mathExcluded.push({ from, to });
    const render =
      t.type === 'table' ||
      t.type === 'hr' ||
      t.type === 'blockMath' ||
      (t.type === 'code' && t.lang === 'mermaid') ||
      (t.type === 'paragraph' && /^!\[[^\]]*\]\([^\n]+\)$/.test(raw));
    if (render && to > from && !active(from, to)) {
      add(
        from,
        to,
        Decoration.replace({
          widget: new RenderedBlock(raw, state.facet(documentPath), from),
          block: true,
        }),
      );
      blocks.push({ from, to });
    }
  }
  syntaxTree(state).iterate({
    enter(node) {
      const { from, to, name } = node;
      if (['InlineCode', 'Link', 'Image', 'Escape'].includes(name)) mathExcluded.push({ from, to });
      if (blocks.some((b) => from >= b.from && from < b.to)) return false;
      const line = state.doc.lineAt(from);
      if (name === 'TaskMarker') {
        add(
          from,
          to,
          Decoration.replace({
            widget: new TaskCheckbox(state.doc.sliceString(from, to).toLowerCase() === '[x]', from),
          }),
        );
        return false;
      }
      if (
        name === 'ListMark' &&
        !active(from, to) &&
        /^[-+*]$/.test(state.doc.sliceString(from, to))
      ) {
        add(from, to, Decoration.replace({ widget: new Bullet() }));
      }

      if (/^ATXHeading[1-6]$/.test(name))
        add(line.from, line.from, Decoration.line({ class: `cm-heading cm-h${name.slice(-1)}` }));
      if (name === 'Blockquote')
        add(line.from, line.from, Decoration.line({ class: 'cm-quote-line' }));
      if (name === 'FencedCode') {
        for (let n = line.number; n <= state.doc.lineAt(to).number; n++)
          add(
            state.doc.line(n).from,
            state.doc.line(n).from,
            Decoration.line({ class: 'cm-code-line' }),
          );
      }
      if (['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link'].includes(name)) {
        add(from, to, Decoration.mark({ class: `cm-rich-${name.toLowerCase()}` }));
      }
      if (
        !active(from, to) &&
        ['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark'].includes(name)
      ) {
        // Code fence markers retain their line height to prevent unpredictable vertical jumps.
        if (name === 'CodeMark' && line.text.trim().match(/^(```|~~~)/)) return;
        let end = to;
        if (['HeaderMark', 'QuoteMark'].includes(name) && state.doc.sliceString(to, to + 1) === ' ')
          end++;
        if (end > from) add(from, end, Decoration.replace({}));
      }
    },
  });
  const source = state.doc.toString();
  const customRanges: { from: number; to: number }[] = [];
  for (const rule of inlineSyntaxRules()) {
    let from = source.indexOf(rule.open);
    while (from >= 0) {
      let escaping = 0;
      for (let n = from - 1; n >= 0 && source[n] === '\\'; n--) escaping++;
      const match = escaping % 2 === 0 ? inlineMatch(source.slice(from), rule) : null;
      if (match) {
        const to = from + match.raw.length;
        if (
          !active(from, to) &&
          ![...blocks, ...mathExcluded, ...customRanges].some(
            (range) => from < range.to && to > range.from,
          )
        ) {
          add(from, from + rule.open.length, Decoration.replace({}));
          add(
            from + rule.open.length,
            to - rule.close.length,
            Decoration.mark({
              class: 'cm-custom-syntax',
              attributes: {
                style: `background-color:${rule.color};color:${syntaxInk(rule.color)}`,
                title: rule.name,
              },
            }),
          );
          add(to - rule.close.length, to, Decoration.replace({}));
          customRanges.push({ from, to });
        }
        from = source.indexOf(rule.open, to);
      } else from = source.indexOf(rule.open, from + rule.open.length);
    }
  }
  const mathPattern = /(?<![\\$])\$(?!\s|\$)((?:\\.|[^$\n])+?)(?<!\s)\$(?![\d$])/g;
  for (const match of source.matchAll(mathPattern)) {
    const from = match.index,
      to = from + match[0].length;
    if (
      !active(from, to) &&
      ![...blocks, ...mathExcluded, ...customRanges].some(
        (range) => from < range.to && to > range.from,
      )
    ) {
      add(from, to, Decoration.replace({ widget: new InlineMath(match[1], from) }));
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  entries.sort((a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
  for (const e of entries) builder.add(e.from, e.to, e.deco);
  return builder.finish();
}
const decorations = StateField.define<DecorationSet>({
  create: build,
  update: (old, tr) =>
    tr.docChanged ||
    tr.selection ||
    tr.reconfigured ||
    tr.effects.some((e) => e.is(compositionState) || e.is(syntaxChanged))
      ? build(tr.state)
      : old,
  provide: (f) => EditorView.decorations.from(f),
});
export const livePreview = [composing, decorations];
