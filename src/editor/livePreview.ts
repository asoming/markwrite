import { sourceBlocks } from './sourceBlocks';
import { t, getLanguage } from '../lib/i18n';
import {
  StateField,
  Facet,
  StateEffect,
  RangeSetBuilder,
  type EditorState,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { renderMarkdown, hydrateDiagrams } from '../lib/markdown';
import { assetData } from '../lib/platform';
import katex from 'katex';
import { inlineSyntaxRules, inlineMatch, syntaxInk } from '../lib/syntax';
import { parseImageMarkup } from '../lib/imageMarkup';
import { attachDirectTable, type DirectBlockController } from './directTable';
import { attachDirectImage } from './directImage';
import './directEditing.css';

const directBlocks = new WeakMap<
  HTMLElement,
  {
    position: number;
    path: string;
    raw: string;
    language: string;
    controller: DirectBlockController | null;
  }
>();

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
  readonly language = getLanguage();
  constructor(
    readonly checked: boolean,
    readonly position: number,
  ) {
    super();
  }
  eq(other: TaskCheckbox) {
    return (
      this.language === other.language &&
      this.checked === other.checked &&
      this.position === other.position
    );
  }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? t('标记为未完成') : t('标记为完成'));
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
  readonly language = getLanguage();
  constructor(
    readonly formula: string,
    readonly position: number,
  ) {
    super();
  }
  eq(other: InlineMath) {
    return (
      this.language === other.language &&
      this.formula === other.formula &&
      this.position === other.position
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement('span');
    span.className = 'cm-inline-math';
    span.title = t('点击编辑公式');
    span.setAttribute('aria-label', t('公式 {0}', undefined, [this.formula]));
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
      span.title = t('公式语法有误，点击修改');
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
class CustomInline extends WidgetType {
  readonly language = getLanguage();
  constructor(
    readonly text: string,
    readonly name: string,
    readonly color: string,
    readonly position: number,
    readonly markerLength: number,
  ) {
    super();
  }
  eq(other: CustomInline) {
    return (
      this.language === other.language &&
      this.text === other.text &&
      this.name === other.name &&
      this.color === other.color &&
      this.position === other.position &&
      this.markerLength === other.markerLength
    );
  }
  toDOM(view: EditorView) {
    const mark = document.createElement('mark');
    mark.className = 'cm-custom-syntax';
    mark.textContent = this.text;
    mark.title = t('{0} · 点击编辑', undefined, [this.name]);
    mark.style.backgroundColor = this.color;
    mark.style.color = syntaxInk(this.color);
    mark.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.position + this.markerLength },
        scrollIntoView: true,
      });
      view.focus();
    });
    return mark;
  }
  ignoreEvent() {
    return true;
  }
}
class RenderedBlock extends WidgetType {
  readonly language = getLanguage();
  constructor(
    readonly raw: string,
    readonly path: string,
    readonly position: number,
    readonly inline = false,
  ) {
    super();
  }
  eq(other: RenderedBlock) {
    return (
      this.language === other.language &&
      this.raw === other.raw &&
      this.path === other.path &&
      this.position === other.position &&
      this.inline === other.inline
    );
  }
  toDOM(view: EditorView) {
    const element = document.createElement('div');
    element.className = 'live-block markdown-body' + (this.inline ? ' live-inline-image' : '');
    element.innerHTML = renderMarkdown(this.raw);
    element.title = t('点击编辑 Markdown 源码');
    const record = {
      position: this.position,
      path: this.path,
      raw: this.raw,
      language: this.language,
      controller: null as DirectBlockController | null,
    };
    directBlocks.set(element, record);
    if (element.querySelector('table')) {
      const tools = document.createElement('div');
      tools.className = 'live-block-tools';
      const button = document.createElement('button');
      button.textContent = t('编辑表格');
      button.type = 'button';
      button.title = t('在表格窗口直接编辑单元格');
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () =>
        view.dom.dispatchEvent(
          new CustomEvent('markwrite:edit-table', {
            detail: { from: record.position, to: record.position + record.raw.length },
            bubbles: true,
          }),
        ),
      );
      tools.appendChild(button);
      element.prepend(tools);
      record.controller = attachDirectTable(view, element, this.raw, this.position);
    } else if (parseImageMarkup(this.raw)) {
      record.controller = attachDirectImage(view, element, this.raw, this.position);
    }
    element.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('a,button')) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: record.position }, scrollIntoView: true });
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
          image.title = t('网络图片地址无效，点击正文检查链接');
          continue;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'remote-image-load';
        button.textContent = t('加载网络图片（将访问 {0}）', undefined, [url.hostname]);
        button.addEventListener('click', () => {
          image.referrerPolicy = 'no-referrer';
          image.onload = () => {
            image.classList.remove('pending-image');
            button.remove();
            view.requestMeasure();
          };
          image.onerror = () => {
            button.textContent = t('图片加载失败，点击重试');
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
          image.title = t('图片不可用，点击检查路径');
        });
    }
    return element;
  }
  updateDOM(element: HTMLElement) {
    const record = directBlocks.get(element);
    if (!record || record.path !== this.path || record.language !== this.language) return false;
    if (!record.controller?.update(this.raw, this.path, this.position)) return false;
    record.position = this.position;
    record.raw = this.raw;
    return true;
  }
  destroy(element: HTMLElement) {
    directBlocks.get(element)?.controller?.destroy();
    directBlocks.delete(element);
  }
  ignoreEvent() {
    return true;
  }
}
function build(state: EditorState): DecorationSet {
  if (!state.facet(liveMode) || state.field(composing)) return Decoration.none;
  if (state.doc.length > 300_000) {
    // A pasted data URI can exceed the text-rendering budget on its own. Keep
    // standalone images visible without enabling rich parsing for the large text.
    const source = state.doc.toString();
    if (!source.includes('data:image/')) return Decoration.none;
    const images = [];
    let offset = 0,
      fence: { marker: string; length: number } | undefined;
    for (const line of source.split('\n')) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
        else if (
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
      } else if (
        !fence &&
        /^ {0,3}(?:!\[|<img\b|<figure\b)/i.test(line) &&
        parseImageMarkup(line)
      ) {
        images.push(
          Decoration.replace({
            widget: new RenderedBlock(line, state.facet(documentPath), offset),
            block: true,
          }).range(offset, offset + line.length),
        );
      }
      offset += line.length + 1;
    }
    return Decoration.set(images);
  }
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
  for (const t of sourceBlocks(state.doc.toString())) {
    const { from, to, raw } = t;
    if (['fence', 'code_block', 'block_math', 'html_block'].includes(t.type))
      mathExcluded.push({ from, to });
    const image =
      (t.type === 'paragraph_open' || t.type === 'html_block') && !!parseImageMarkup(raw);
    const render =
      t.type === 'table_open' ||
      t.type === 'hr' ||
      t.type === 'block_math' ||
      (t.type === 'fence' && t.info === 'mermaid') ||
      image;
    if (render && to > from && (image || !active(from, to))) {
      add(
        from,
        to,
        Decoration.replace({
          widget: new RenderedBlock(raw, state.facet(documentPath), from),
          block: true,
        }),
      );
      blocks.push({ from, to });
    } else if (t.type === 'paragraph_open') {
      // Markdown permits an image on the next line without a blank paragraph.
      // Rendering that image must not hide or rewrite the neighboring text.
      let offset = from;
      for (const line of raw.split('\n')) {
        if (/^ {0,3}(?:!\[|<img\b)/i.test(line) && parseImageMarkup(line)) {
          const end = offset + line.length;
          add(
            offset,
            end,
            Decoration.replace({
              widget: new RenderedBlock(line, state.facet(documentPath), offset),
              block: true,
            }),
          );
          blocks.push({ from: offset, to: end });
        }
        offset += line.length + 1;
      }
    }
  }
  syntaxTree(state).iterate({
    enter(node) {
      const { from, to, name } = node;
      if (['InlineCode', 'Link', 'Image', 'Escape'].includes(name)) mathExcluded.push({ from, to });
      if (blocks.some((b) => from >= b.from && from < b.to)) return false;
      if (name === 'Image') {
        const raw = state.doc.sliceString(from, to);
        if (parseImageMarkup(raw)) {
          add(
            from,
            to,
            Decoration.replace({
              widget: new RenderedBlock(raw, state.facet(documentPath), from, true),
            }),
          );
          return false;
        }
      }
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
        // Keep editable text nodes instead of empty replacement widgets: WebKitGTK
        // can abort its web process when IME/AT-SPI traverses those replacements.
        if (end > from) add(from, end, Decoration.mark({ class: 'cm-hidden-syntax' }));
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
            (range) => from >= range.from && from < range.to,
          )
        ) {
          add(
            from,
            to,
            Decoration.replace({
              widget: new CustomInline(match.text, rule.name, rule.color, from, rule.open.length),
            }),
          );
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
  update: (old, tr) => {
    // Keep the DOM around an active IME candidate stable. Removing every decoration
    // on compositionstart can destroy WebKit's composition context and lose the commit.
    if (tr.state.field(composing)) return old.map(tr.changes);
    return tr.docChanged ||
      tr.selection ||
      tr.reconfigured ||
      tr.effects.some((e) => e.is(compositionState) || e.is(syntaxChanged))
      ? build(tr.state)
      : old;
  },
  provide: (f) => EditorView.decorations.from(f),
});
export const livePreview = [composing, decorations];
