import { sanitizeRenderedMarkdown } from './markdown';

export type ReadingClipboard = { html: string; text: string };
function plain(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (!(node instanceof Element))
    return [...node.childNodes].map((child) => plain(child, depth)).join('');
  const tag = node.tagName.toLowerCase();
  if (tag === 'img') return node.getAttribute('alt') || '';
  if (tag === 'br') return '\n';
  if (tag === 'pre') return (node.textContent || '') + '\n\n';
  if (tag === 'table')
    return (
      [...node.querySelectorAll('tr')]
        .map((row) => [...row.children].map((cell) => plain(cell).trim()).join('\t'))
        .join('\n') + '\n\n'
    );
  if (tag === 'ol' || tag === 'ul') {
    const start = Number(node.getAttribute('start')) || 1;
    return (
      [...node.children]
        .filter((child) => child.tagName === 'LI')
        .map(
          (item, index) =>
            `${'  '.repeat(depth)}${tag === 'ol' ? `${start + index}.` : '•'} ${[...item.childNodes]
              .map((child) => plain(child, depth + 1))
              .join('')
              .trim()}\n`,
        )
        .join('') + (depth ? '' : '\n')
    );
  }
  const text = [...node.childNodes].map((child) => plain(child, depth)).join('');
  return /^(?:p|h[1-6]|blockquote|section|div)$/.test(tag) ? text.trim() + '\n\n' : text;
}

/** Temporary detached fragments are released each batch; the whole document never mounts. */
export async function prepareReadingClipboard(
  parts: readonly string[],
  cancelled: () => boolean = () => false,
): Promise<ReadingClipboard> {
  const html: string[] = [],
    text: string[] = [];
  let turn = performance.now();
  for (const part of parts) {
    if (cancelled()) throw new DOMException('Document changed', 'AbortError');
    const safe = sanitizeRenderedMarkdown(part, { preserveHeadingIds: true });
    html.push(safe);
    const template = document.createElement('template');
    template.innerHTML = safe;
    text.push(plain(template.content));
    template.innerHTML = '';
    if (performance.now() - turn > 12) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      turn = performance.now();
    }
  }
  return { html: html.join(''), text: text.join('').trimEnd() };
}
