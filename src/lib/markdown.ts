import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import type { Heading } from './types';
import type { ExtensionPack } from './extensions';
import { setInlineSyntax, inlineSyntaxRules, inlineMatch, syntaxInk } from './syntax';
import { t } from './i18n';

export function configureInlineSyntax(packs: readonly ExtensionPack[]) {
  const count = setInlineSyntax(packs);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('markwrite-syntax-configured'));
  return count;
}

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
export const md = new Marked({ gfm: true, breaks: false });
md.use({
  extensions: [
    {
      name: 'customInline',
      level: 'inline',
      start(source) {
        const positions = inlineSyntaxRules()
          .map((rule) => source.indexOf(rule.open))
          .filter((position) => position >= 0);
        return positions.length ? Math.min(...positions) : -1;
      },
      tokenizer(source) {
        for (const rule of inlineSyntaxRules()) {
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
      start: (s) => s.indexOf('[['),
      tokenizer(s) {
        const match = /^\[\[([^\]\n]+)\]\]/.exec(s);
        if (match) {
          const [target, label] = match[1].split('|');
          return { type: 'wikiLink', raw: match[0], target: target.trim(), text: label || target };
        }
      },
      renderer(token) {
        return `<a href="#wiki:${encodeURIComponent(token.target)}" class="wiki-link">${escapeHtml(token.text)}</a>`;
      },
    },
    {
      name: 'blockMath',
      level: 'block',
      start: (s) => s.indexOf('$$'),
      tokenizer(s) {
        const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n|$)/.exec(s);
        if (m) return { type: 'blockMath', raw: m[0], text: m[1] };
      },
      renderer(t) {
        return math(t.text, true);
      },
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start: (s) => s.indexOf('$'),
      tokenizer(s) {
        const m = /^\$(?!\s|\$)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(s);
        if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
      },
      renderer(t) {
        return math(t.text, false);
      },
    },
  ],
});
function math(text: string, displayMode: boolean) {
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
    return `<code class="math-error" title="${t('公式语法有误', 'Invalid formula syntax')}">${escapeHtml(text)}</code>`;
  }
}
md.use({
  renderer: {
    link(token) {
      if (!/^file:\/\//i.test(token.href)) return false;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      // DOMPurify intentionally blocks file: in generic URL attributes. Carry only
      // explicit local-document links through an inert attribute, then restore on anchors.
      return `<a data-local-href="${escapeHtml(token.href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
    },
    html(token) {
      return DOMPurify.sanitize(token.text, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['style', 'srcset'],
      });
    },
    checkbox(token) {
      return `<span class="task-check ${token.checked ? 'checked' : ''}" aria-label="${token.checked ? t('已完成', 'Complete') : t('未完成', 'Incomplete')}">${token.checked ? '✓' : ''}</span>`;
    },
    code(token) {
      if (token.lang === 'mermaid')
        return `<div class="diagram" data-diagram="${encodeURIComponent(token.text)}"><pre>${escapeHtml(token.text)}</pre></div>`;
      return `<pre><code class="language-${escapeHtml(token.lang || 'text')}">${escapeHtml(token.text)}</code></pre>`;
    },
  },
});
export function renderMarkdown(source: string): string {
  const html = md.parse(source.replace(/^\uFEFF/, '')) as string;
  const safe = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-diagram', 'data-tex', 'data-display'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['srcset'],
  });
  const template = document.createElement('template');
  template.innerHTML = safe;
  const counts = new Map<string, number>();
  template.content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const base = slug(h.textContent || '');
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  });
  template.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(src)) {
      img.removeAttribute('src');
      img.dataset.asset = src;
      img.alt = img.alt || t('图片');
      img.classList.add('pending-image');
    }
  });
  template.content.querySelectorAll('a').forEach((a) => {
    const local = a.getAttribute('data-local-href');
    if (local && /^file:\/\//i.test(local)) a.setAttribute('href', local);
    a.rel = 'noreferrer noopener';
  });
  template.content
    .querySelectorAll('[data-local-href]')
    .forEach((node) => node.removeAttribute('data-local-href'));
  return template.innerHTML;
}
let diagramCounter = 0;
export async function hydrateDiagrams(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-diagram]')];
  if (!nodes.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral',
    fontFamily: 'sans-serif',
    suppressErrorRendering: true,
  });
  for (const node of nodes) {
    if (node.dataset.rendered) continue;
    node.dataset.rendered = 'true';
    try {
      const { svg } = await mermaid.render(
        `diagram-${++diagramCounter}`,
        decodeURIComponent(node.dataset.diagram || ''),
      );
      if (root.contains(node))
        node.innerHTML = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignObject'],
          ADD_ATTR: ['dominant-baseline'],
        });
    } catch {
      if (root.contains(node)) {
        node.classList.add('diagram-error');
        node.title = t('图表语法有误，请检查源码', 'Invalid diagram syntax. Check the source.');
      }
    }
  }
}
export function getHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  let line = 1;
  const counts = new Map<string, number>();
  for (const token of md.lexer(content)) {
    if (token.type === 'heading') {
      const text = token.text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '');
      const base = slug(text);
      const n = counts.get(base) || 0;
      counts.set(base, n + 1);
      headings.push({
        level: token.depth,
        text,
        line,
        id: n ? `${base}-${n}` : base,
      });
    }
    line += (token.raw.match(/\n/g) || []).length;
  }
  return headings;
}
export function wordCount(content: string) {
  const text = content.replace(/data:image\/[a-z\d.+-]+;base64,[a-z\d+/=]+/gi, '');
  return (
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || []
  ).length;
}
export function normalizeContent(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}
export function serializeContent(text: string, bom: boolean, crlf: boolean) {
  return (bom ? '\uFEFF' : '') + (crlf ? text.replace(/\r?\n/g, '\r\n') : text);
}
