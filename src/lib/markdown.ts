import DOMPurify from 'dompurify';
import type { Heading } from './types';
import type { ExtensionPack } from './extensions';
import { setInlineSyntax } from './syntax';
import { t } from './i18n';
import {
  slug,
  markdownHeadings,
  renderMarkdownRaw,
  setMarkdownConfiguration,
  type MarkdownParseOptions,
} from './markdownParser';
export { md, compatibilityMd, escapeHtml, slug, markdownConfiguration } from './markdownParser';
export type { MarkdownParseOptions } from './markdownParser';
export function configureMarkdown(options: MarkdownParseOptions) {
  setMarkdownConfiguration(options);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('markwrite-syntax-configured'));
}
export function configureInlineSyntax(packs: readonly ExtensionPack[]) {
  const count = setInlineSyntax(packs);
  setMarkdownConfiguration({});
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('markwrite-syntax-configured'));
  return count;
}
export function renderMarkdown(source: string, options?: MarkdownParseOptions): string {
  return sanitizeRenderedMarkdown(renderMarkdownRaw(source, options), { preserveHeadingIds: true });
}
export function sanitizeRenderedMarkdown(
  html: string,
  options: { headingCounts?: Map<string, number>; preserveHeadingIds?: boolean } = {},
): string {
  const safe = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-diagram', 'data-tex', 'data-display'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed', 'video', 'audio'],
    FORBID_ATTR: ['srcset', 'background'],
  });
  const template = document.createElement('template');
  template.innerHTML = safe;
  const counts = options.headingCounts || new Map<string, number>();
  template.content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    if (options.preserveHeadingIds && h.id) return;
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
  const nodes = root.matches('[data-diagram]')
    ? [root]
    : [...root.querySelectorAll<HTMLElement>('[data-diagram]')];
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
  return markdownHeadings(content);
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
