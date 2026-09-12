import { Marked, type Token } from 'marked';
import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type Token as MarkdownToken,
} from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import katex from 'katex';
import { decodeHTML } from 'entities';
import { inlineSyntaxRules, inlineMatch, syntaxInk, type InlineSyntax } from './syntax';

/** Serializable options: the same parser runs in the editor, exports, and reader worker. */
export type MarkdownParseOptions = {
  flavor?: 'commonmark' | 'gfm';
  compatibility?: boolean;
  math?: boolean;
  footnotes?: boolean;
  inlineSyntax?: readonly InlineSyntax[];
  /** Plain parser output, used to verify the upstream CommonMark fixtures. */
  presentation?: boolean;
};
export type MarkdownBlock = {
  html: string;
  raw: string;
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  headingIds: string[];
};
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-') || 'section';
export const normalizeMarkdown = (source: string) =>
  source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
let configured: MarkdownParseOptions = { compatibility: false };
export const markdownConfiguration = (): MarkdownParseOptions => ({
  ...configured,
  inlineSyntax: [...inlineSyntaxRules()],
});
export function setMarkdownConfiguration(options: MarkdownParseOptions) {
  configured = { ...configured, ...options };
  md = reusableParser(markdownConfiguration());
}

/** HTML is still untrusted here. Final DOMPurify sanitization is mandatory on the main thread.
 * Strip author-supplied style attributes before combining HTML with KaTeX's own styles.
 * Tokenizing tags (including quoted >) preserves opening/closing inline tags across tokens.
 */
function rawHtml(html: string) {
  return html.replace(
    /<!--[\s\S]*?-->|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g,
    (tag) => {
      if (tag.startsWith('<!--')) return tag;
      if (
        /^(?:svg|image|use|foreignobject|math)$/i.test(
          /^<\/?([a-z][a-z0-9:_-]*)/i.exec(tag)?.[1] || '',
        )
      )
        return '';
      if (/^<\//.test(tag)) return tag;
      return tag.replace(
        /([\s/]+)([^\s"'<>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g,
        (attribute, _space, name: string) => {
          if (
            /^<figure\b/i.test(tag) &&
            /^style$/i.test(name) &&
            /^\s+style\s*=\s*(["'])\s*text-align\s*:\s*(left|center|right)\s*;?\s*\1$/i.test(
              attribute,
            )
          )
            return attribute;
          return /^(?:style|srcset)$/i.test(name) ? '' : attribute;
        },
      );
    },
  );
}
export function tokenText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'html') return decodeHTML(token.raw.replace(/<[^>]*>/g, ''));
      if ('tokens' in token && Array.isArray(token.tokens)) return tokenText(token.tokens);
      return decodeHTML(String('text' in token ? token.text : token.raw));
    })
    .join('');
}
function formula(text: string, displayMode: boolean) {
  try {
    const html = katex.renderToString(text, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      output: 'html',
    });
    return `<span class="math-rendered" data-tex="${encodeURIComponent(text)}" data-display="${displayMode}">${html}</span>`;
  } catch {
    return `<code class="math-error" title="公式语法有误 · Invalid formula syntax">${escapeHtml(text)}</code>`;
  }
}
function createMarkdownLexer(options: MarkdownParseOptions = {}): Marked {
  const parser = new Marked({ gfm: options.flavor !== 'commonmark', breaks: false });
  const presentation = options.presentation !== false;
  if (options.compatibility)
    parser.use({
      extensions: [
        {
          name: 'customInline',
          level: 'inline',
          start(source) {
            const positions = (options.inlineSyntax || inlineSyntaxRules())
              .map((rule) => source.indexOf(rule.open))
              .filter((position) => position >= 0);
            return positions.length ? Math.min(...positions) : -1;
          },
          tokenizer(source) {
            for (const rule of options.inlineSyntax || inlineSyntaxRules()) {
              const match = inlineMatch(source, rule);
              if (match)
                return {
                  type: 'customInline',
                  raw: match.raw,
                  text: match.text,
                  syntaxName: rule.name,
                  color: rule.color,
                };
            }
          },
          renderer(token) {
            return `<mark class="syntax-highlight" data-syntax="${escapeHtml(token.syntaxName)}" style="background-color:${token.color};color:${syntaxInk(token.color)}">${escapeHtml(token.text)}</mark>`;
          },
        },
        {
          name: 'wikiLink',
          level: 'inline',
          start: (source) => source.indexOf('[['),
          tokenizer(source) {
            const match = /^\[\[([^\]\n]+)\]\]/.exec(source);
            if (match) {
              const [target, label] = match[1].split('|');
              return {
                type: 'wikiLink',
                raw: match[0],
                target: target.trim(),
                text: label || target,
              };
            }
          },
          renderer(token) {
            return `<a href="#wiki:${encodeURIComponent(token.target)}" class="wiki-link">${escapeHtml(token.text)}</a>`;
          },
        },
      ],
    });
  if (options.math !== false)
    parser.use({
      extensions: [
        {
          name: 'blockMath',
          level: 'block',
          start: (source) => source.indexOf('$$'),
          tokenizer(source) {
            const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n|$)/.exec(source);
            if (match) return { type: 'blockMath', raw: match[0], text: match[1] };
          },
          renderer(token) {
            return formula(token.text, true);
          },
        },
        {
          name: 'inlineMath',
          level: 'inline',
          start: (source) => source.indexOf('$'),
          tokenizer(source) {
            const match = /^\$(?!\s|\$)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(source);
            if (match) return { type: 'inlineMath', raw: match[0], text: match[1] };
          },
          renderer(token) {
            return formula(token.text, false);
          },
        },
      ],
    });
  if (presentation) {
    const counts = new Map<string, number>();
    parser.use({
      hooks: {
        preprocess(source) {
          counts.clear();
          return source;
        },
      },
      renderer: {
        heading(token) {
          const base = slug(tokenText(token.tokens));
          const n = counts.get(base) || 0;
          counts.set(base, n + 1);
          return `<h${token.depth} id="${n ? `${base}-${n}` : base}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
        },
        link(token) {
          if (!/^file:\/\//i.test(token.href)) return false;
          const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
          return `<a data-local-href="${escapeHtml(token.href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
        },
        html(token) {
          return rawHtml(token.text);
        },
        checkbox(token) {
          return `<span class="task-check ${token.checked ? 'checked' : ''}" aria-label="${token.checked ? '已完成 · Complete' : '未完成 · Incomplete'}">${token.checked ? '✓' : ''}</span>`;
        },
        code(token) {
          if (token.lang === 'mermaid')
            return `<div class="diagram" data-diagram="${encodeURIComponent(token.text)}"><pre>${escapeHtml(token.text)}</pre></div>`;
          return `<pre><code class="language-${escapeHtml(token.lang || 'text')}">${escapeHtml(token.text)}</code></pre>`;
        },
      },
    });
  }
  return parser;
}
/** Live binding: callers using lexer follow the currently selected compatibility mode. */
function reusableParser(options: MarkdownParseOptions = {}) {
  const parser = createMarkdownLexer(options);
  // A lexer-only caller never triggers extensions' end-of-document hooks.
  parser.lexer = (source, overrides) => createMarkdownLexer(options).lexer(source, overrides);
  return parser;
}
export let md = reusableParser();
/** Explicit legacy-reference detection only; rendering remains opt-in. */
export const compatibilityMd = reusableParser({ compatibility: true });

function inlineText(tokens: readonly MarkdownToken[]): string {
  return tokens
    .map((token) =>
      token.children
        ? inlineText(token.children)
        : token.type === 'html_inline'
          ? decodeHTML(token.content.replace(/<[^>]*>/g, ''))
          : token.content,
    )
    .join('');
}
export function createMarkdownParser(options: MarkdownParseOptions = {}): MarkdownItInstance {
  const parser = new MarkdownIt('commonmark', { html: true, breaks: false });
  // Match the CommonMark fixture serialization for empty blockquotes, too.
  parser.renderer.rules.blockquote_open = (tokens, index, rendering, _env, renderer) => {
    const html = renderer.renderToken(tokens, index, rendering);
    return html.endsWith('\n') ? html : `${html}\n`;
  };
  if (options.flavor !== 'commonmark') {
    parser.enable(['table', 'strikethrough', 'linkify']);
    parser.set({ linkify: true });
    parser.use(taskLists);
  }
  if (options.footnotes !== false) {
    // The plugin ships CJS-only typings; its runtime accepts the identical ESM parser.
    parser.use(footnote as unknown as (parser: MarkdownItInstance) => void);
    if (!options.compatibility) parser.inline.ruler.disable('footnote_inline');
  }
  if (options.compatibility || options.math !== false) {
    parser.inline.ruler.before('escape', 'markwrite_inline', (state, silent) => {
      const rest = state.src.slice(state.pos);
      if (options.compatibility) {
        for (const rule of options.inlineSyntax || inlineSyntaxRules()) {
          const match = inlineMatch(rest, rule);
          if (match) {
            if (!silent) {
              const token = state.push('custom_inline', '', 0);
              token.content = match.text;
              token.meta = rule;
            }
            state.pos += match.raw.length;
            return true;
          }
        }
        const wiki = /^\[\[([^\]\n]+)\]\]/.exec(rest);
        if (wiki) {
          if (!silent) {
            const [target, label] = wiki[1].split('|');
            const token = state.push('wiki_link', '', 0);
            token.content = label || target;
            token.meta = { target: target.trim() };
          }
          state.pos += wiki[0].length;
          return true;
        }
      }
      if (options.math !== false) {
        const match = /^\$(?!\s|\$)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(rest);
        if (match) {
          if (!silent) {
            const token = state.push('inline_math', '', 0);
            token.content = match[1];
          }
          state.pos += match[0].length;
          return true;
        }
      }
      return false;
    });
    parser.renderer.rules.custom_inline = (tokens, index) => {
      const token = tokens[index];
      return `<mark class="syntax-highlight" data-syntax="${escapeHtml(String(token.meta?.name || ''))}" style="background-color:${String(token.meta?.color || '#fff0a6')};color:${syntaxInk(String(token.meta?.color || '#fff0a6'))}">${escapeHtml(token.content)}</mark>`;
    };
    parser.renderer.rules.wiki_link = (tokens, index) =>
      `<a href="#wiki:${encodeURIComponent(String(tokens[index].meta?.target || ''))}" class="wiki-link">${escapeHtml(tokens[index].content)}</a>`;
    parser.renderer.rules.inline_math = (tokens, index) => formula(tokens[index].content, false);
  }
  if (options.math !== false) {
    parser.block.ruler.before(
      'fence',
      'block_math',
      (state, startLine, endLine, silent) => {
        if (state.sCount[startLine] - state.blkIndent >= 4) return false;
        const start = state.bMarks[startLine] + state.tShift[startLine];
        const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n|$)/.exec(
          state.src.slice(start, endLine < state.bMarks.length ? state.bMarks[endLine] : undefined),
        );
        if (!match) return false;
        if (silent) return true;
        const lines = (match[0].match(/\n/g) || []).length + (match[0].endsWith('\n') ? 0 : 1);
        const token = state.push('block_math', '', 0);
        token.block = true;
        token.content = match[1];
        token.map = [startLine, startLine + lines];
        state.line = startLine + lines;
        return true;
      },
      { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
    );
    parser.renderer.rules.block_math = (tokens, index) => formula(tokens[index].content, true);
  }
  if (options.presentation !== false && options.flavor !== 'commonmark') {
    parser.core.ruler.before('inline', 'markwrite_alerts', (state) => {
      const names: Record<string, string> = {
        NOTE: 'Note',
        TIP: 'Tip',
        IMPORTANT: 'Important',
        WARNING: 'Warning',
        CAUTION: 'Caution',
      };
      state.tokens.forEach((token, index) => {
        if (token.type !== 'blockquote_open' || state.tokens[index + 1]?.type !== 'paragraph_open')
          return;
        const inline = state.tokens[index + 2];
        if (inline?.type !== 'inline') return;
        const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/.exec(
          inline.content,
        );
        if (!marker) return;
        token.attrJoin('class', `markdown-alert markdown-alert-${marker[1].toLowerCase()}`);
        inline.content = `**${names[marker[1]]}**\n${inline.content.slice(marker[0].length)}`;
      });
    });
  }
  if (options.presentation !== false) {
    parser.core.ruler.push('markwrite_headings', (state) => {
      const counts = new Map<string, number>();
      for (let i = 0; i < state.tokens.length; i++) {
        const token = state.tokens[i];
        if (token.type !== 'heading_open') continue;
        const text = inlineText(state.tokens[i + 1]?.children || []);
        const base = slug(text),
          n = counts.get(base) || 0;
        counts.set(base, n + 1);
        token.attrSet('id', n ? `${base}-${n}` : base);
        token.meta = { ...token.meta, headingText: text };
      }
    });
    const validate = parser.validateLink;
    parser.validateLink = (href) =>
      /^file:\/\//i.test(href) ||
      /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(href) ||
      validate(href);
    parser.renderer.rules.link_open = (tokens, index, rendering, _env, renderer) => {
      const token = tokens[index];
      const href = String(token.attrGet('href') || '');
      if (href && /^file:\/\//i.test(href)) {
        token.attrs = token.attrs?.filter(([name]) => name !== 'href') || [];
        token.attrSet('data-local-href', href);
      }
      return renderer.renderToken(tokens, index, rendering);
    };
    parser.renderer.rules.html_block = (tokens, index) => rawHtml(tokens[index].content);
    parser.renderer.rules.html_inline = (tokens, index) => {
      const html = tokens[index].content;
      if (
        /^<input class="task-list-item-checkbox"(?: checked="")? disabled="" type="checkbox">$/.test(
          html,
        )
      ) {
        const checked = html.includes('checked=');
        return `<span class="task-check ${checked ? 'checked' : ''}" aria-label="${checked ? '已完成 · Complete' : '未完成 · Incomplete'}">${checked ? '✓' : ''}</span>`;
      }
      return rawHtml(html);
    };
    parser.renderer.rules.fence = (tokens, index) => {
      const token = tokens[index],
        language = parser.utils.unescapeAll(token.info).trim().split(/\s+/)[0] || 'text';
      const content = token.content.replace(/\n$/, '');
      if (language === 'mermaid' && options.flavor !== 'commonmark')
        return `<div class="diagram" data-diagram="${encodeURIComponent(content)}"><pre>${escapeHtml(content)}</pre></div>`;
      return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(content)}</code></pre>`;
    };
    parser.renderer.rules.code_block = (tokens, index) =>
      `<pre><code class="language-text">${escapeHtml(tokens[index].content.replace(/\n$/, ''))}</code></pre>`;
  }
  return parser;
}
export type MarkdownEnvironment = Record<string, unknown>;
export function parseMarkdownDocument(source: string, options?: MarkdownParseOptions) {
  const parser = createMarkdownParser({ ...markdownConfiguration(), ...options });
  const normalized = normalizeMarkdown(source);
  const env: MarkdownEnvironment = {};
  return { parser, source: normalized, env, tokens: parser.parse(normalized, env) };
}
export function lexMarkdown(source: string, options?: MarkdownParseOptions): MarkdownToken[] {
  return parseMarkdownDocument(source, options).tokens;
}
export function renderTokensRaw(
  tokens: MarkdownToken[],
  options?: MarkdownParseOptions,
  env: MarkdownEnvironment = {},
): string {
  const parser = createMarkdownParser({ ...markdownConfiguration(), ...options });
  return parser.renderer.render(tokens, parser.options, env);
}
export function renderMarkdownRaw(source: string, options?: MarkdownParseOptions): string {
  const document = parseMarkdownDocument(source, options);
  return document.parser.renderer.render(document.tokens, document.parser.options, document.env);
}
export function markdownHeadings(source: string) {
  const { tokens } = parseMarkdownDocument(source);
  return tokens
    .filter((token) => token.type === 'heading_open' && token.map)
    .map((token) => ({
      level: Number(token.tag.slice(1)),
      text: String(token.meta?.headingText || ''),
      line: token.map![0] + 1,
      id: String(token.attrGet('id') || 'section'),
    }));
}
const htmlVoid = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
function updateHtmlStack(html: string, stack: string[]) {
  for (const match of html.matchAll(
    /<!--[\s\S]*?-->|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g,
  )) {
    const tag = match[0];
    const name = /^<\/?([a-z][a-z0-9:_-]*)/i.exec(tag)?.[1].toLowerCase();
    if (!name || htmlVoid.has(name)) continue;
    if (tag.startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.length = index;
    } else if (!/\/\s*>$/.test(tag)) stack.push(name);
  }
}
/** A complete tokenization pass resolves references and footnotes. Rendering then
 * yields complete top-level blocks, including matched list/table wrappers.
 * Offsets are in BOM-free, LF-normalized source; lines are one-based.
 */
export function* renderMarkdownBlocks(
  source: string,
  options?: MarkdownParseOptions,
): Generator<MarkdownBlock> {
  const document = parseMarkdownDocument(source, options);
  const { tokens, parser, env } = document;
  const lineOffsets = [0];
  for (let offset = 0; offset < document.source.length; offset++)
    if (document.source[offset] === '\n') lineOffsets.push(offset + 1);
  let previousLine = 0;
  for (let first = 0; first < tokens.length;) {
    let end = first + 1;
    if (tokens[first].nesting === 1) {
      let depth = 1;
      while (end < tokens.length && depth) depth += tokens[end++].nesting;
    }
    let html = parser.renderer.render(tokens.slice(first, end), parser.options, env);
    // HTML wrappers can span otherwise separate Markdown blocks. Keep their
    // matched content together so per-block DOM sanitization cannot close them early.
    if (tokens[first].type === 'html_block') {
      const stack: string[] = [];
      updateHtmlStack(html, stack);
      while (stack.length && end < tokens.length) {
        const next = end++;
        if (tokens[next].nesting === 1) {
          let depth = 1;
          while (end < tokens.length && depth) depth += tokens[end++].nesting;
        }
        const fragment = parser.renderer.render(tokens.slice(next, end), parser.options, env);
        html += fragment;
        updateHtmlStack(fragment, stack);
      }
    }
    const block = tokens.slice(first, end);
    let fromLine = Infinity,
      toLine = 0;
    for (const token of block)
      if (token.map) {
        fromLine = Math.min(fromLine, token.map[0]);
        toLine = Math.max(toLine, token.map[1]);
      }
    if (fromLine === Infinity) fromLine = toLine = previousLine;
    const from = lineOffsets[fromLine] ?? document.source.length;
    const to = lineOffsets[toLine] ?? document.source.length;
    if (html)
      yield {
        html,
        raw: document.source.slice(from, to),
        from,
        to,
        fromLine: fromLine + 1,
        toLine: toLine + 1,
        headingIds: block
          .filter((token) => token.type === 'heading_open')
          .map((token) => String(token.attrGet('id') || '')),
      };
    previousLine = toLine;
    first = end;
  }
}
