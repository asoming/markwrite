import DOMPurify from 'dompurify';
import { graphicPng } from './export';
import { formulaSvg } from './exportMath';

export type RichClipboardTarget = 'wechat' | 'feishu';
export type RichClipboardPayload = {
  html: string;
  text: string;
  title: string;
  target: RichClipboardTarget;
  imageCount: number;
  warnings: string[];
};
const rasterSource = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i;
const styles: Record<string, string> = {
  h1: 'font-size:28px;line-height:1.35;font-weight:700;margin:30px 0 18px;color:#22252d',
  h2: 'font-size:23px;line-height:1.4;font-weight:700;margin:28px 0 16px;color:#22252d',
  h3: 'font-size:20px;line-height:1.4;font-weight:700;margin:24px 0 14px;color:#22252d',
  h4: 'font-size:18px;font-weight:700;margin:22px 0 12px;color:#22252d',
  h5: 'font-size:17px;font-weight:700;margin:20px 0 10px;color:#22252d',
  h6: 'font-size:16px;font-weight:700;margin:20px 0 10px;color:#22252d',
  p: 'margin:0 0 16px;line-height:1.8;overflow-wrap:break-word',
  blockquote:
    'margin:18px 0;padding:10px 16px;border-left:3px solid #6380bb;background-color:#f5f7fb;color:#586174',
  pre: 'font-family:monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:break-word;padding:16px;border-radius:6px;background-color:#f5f6f8;color:#30343c;margin:18px 0',
  code: 'font-family:monospace;font-size:0.92em;background-color:#f0f2f5;color:#3d4658;border-radius:3px;padding:1px 3px',
  ul: 'padding-left:26px;margin:12px 0 18px',
  ol: 'padding-left:26px;margin:12px 0 18px',
  li: 'margin:6px 0;line-height:1.8',
  table: 'border-collapse:collapse;width:100%;margin:18px 0;font-size:14px',
  th: 'padding:9px 12px;border:1px solid #dce1e8;background-color:#f3f5f9;font-weight:700;text-align:left',
  td: 'padding:9px 12px;border:1px solid #dce1e8;vertical-align:top',
  hr: 'border:0;border-top:1px solid #dce1e8;margin:26px 0',
  a: 'color:#365fac;text-decoration:underline',
  strong: 'font-weight:700',
  b: 'font-weight:700',
  em: 'font-style:italic',
  i: 'font-style:italic',
  s: 'text-decoration:line-through',
  del: 'text-decoration:line-through',
  sup: 'font-size:0.75em;vertical-align:super;line-height:0',
  sub: 'font-size:0.75em;vertical-align:sub;line-height:0',
  img: 'max-width:100%;height:auto;vertical-align:middle',
  mark: 'background-color:#fff0a6;color:#24272e',
};
function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return node.parentElement?.matches('table,thead,tbody,tr') && !node.textContent?.trim()
      ? ''
      : node.textContent || '';
  if (!(node instanceof Element)) return [...node.childNodes].map(plainText).join('');
  if (node.matches('[data-tex]'))
    return `${node.getAttribute('data-display') === 'true' ? '$$' : '$'}${decodeURIComponent(node.getAttribute('data-tex') || '')}${node.getAttribute('data-display') === 'true' ? '$$' : '$'}`;
  if (node.matches('[data-diagram]'))
    return `\n\n\`\`\`mermaid\n${decodeURIComponent(node.getAttribute('data-diagram') || '')}\n\`\`\`\n\n`;
  if (node.matches('img')) return `[${node.getAttribute('alt') || '图片 · Image'}]`;
  if (node.matches('br')) return '\n';
  if (node.matches('.task-check')) return node.classList.contains('checked') ? '[x]' : '[ ]';
  if (node.matches('script,style')) return '';
  let text = [...node.childNodes].map(plainText).join('');
  if (node.matches('td,th')) text += '\t';
  else if (node.matches('tr,li')) text = text.trimEnd() + '\n';
  else if (node.matches('p,h1,h2,h3,h4,h5,h6,pre,blockquote,ul,ol,section,div'))
    text = text.trimEnd() + '\n\n';
  return text;
}
/** Produces portable inline HTML in memory. The caller hydrates authorized local
 * images first; this function never uploads, resolves URLs, or reads other files. */
export async function prepareRichClipboard(
  article: HTMLElement,
  options: { target: RichClipboardTarget; title: string },
  raster = graphicPng,
): Promise<RichClipboardPayload> {
  if (article.querySelector('.diagram-error,.math-error'))
    throw new Error('请先修正公式或图表错误。 · Correct formula or diagram errors first.');
  const text = plainText(article)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const clone = article.cloneNode(true) as HTMLElement;
  for (const node of clone.querySelectorAll<HTMLElement>('[data-tex],[data-diagram]')) {
    if (!clone.contains(node)) continue;
    let svg: SVGElement | null;
    const isMath = node.hasAttribute('data-tex');
    if (isMath) {
      const template = document.createElement('template');
      template.innerHTML = formulaSvg(
        decodeURIComponent(node.dataset.tex || ''),
        node.dataset.display === 'true',
      );
      svg = template.content.querySelector('svg');
    } else svg = node.querySelector('svg');
    if (!svg) throw new Error('图表尚未完成渲染。 · A diagram has not finished rendering.');
    const graphic = await raster(svg);
    const image = document.createElement('img');
    image.src = graphic.source;
    image.alt = isMath ? decodeURIComponent(node.dataset.tex || '') : '图表 · Diagram';
    image.width = Math.max(1, Math.round(graphic.width));
    image.height = Math.max(1, Math.round(graphic.height));
    const display = !isMath || node.dataset.display === 'true';
    image.dataset.copyDisplay = display ? 'block' : 'inline';
    if (display) {
      const paragraph = document.createElement('p');
      paragraph.append(image);
      node.replaceWith(paragraph);
    } else node.replaceWith(image);
  }
  for (const svg of clone.querySelectorAll<SVGElement>('svg')) {
    const graphic = await raster(svg);
    const image = document.createElement('img');
    image.src = graphic.source;
    image.alt = '图形 · Graphic';
    image.width = Math.round(graphic.width);
    image.height = Math.round(graphic.height);
    image.dataset.copyDisplay = 'block';
    svg.replaceWith(image);
  }
  for (const image of clone.querySelectorAll('img'))
    if (!rasterSource.test(image.getAttribute('src') || ''))
      throw new Error(
        `图片“${image.alt || '未命名'}”尚未加载，未复制缺失内容。 · An image is not loaded.`,
      );
  for (const node of clone.querySelectorAll<HTMLElement>('*')) {
    const tag = node.tagName.toLowerCase();
    const alignment = node.style.textAlign;
    node.removeAttribute('style');
    if (styles[tag]) node.setAttribute('style', styles[tag]);
    if (node.matches('td,th') && /^(left|center|right)$/.test(alignment))
      node.style.textAlign = alignment;
    if (node.matches('pre code'))
      node.setAttribute(
        'style',
        'font:inherit;padding:0;background-color:transparent;white-space:pre-wrap',
      );
    if (node.matches('.task-check'))
      node.replaceWith(document.createTextNode(node.classList.contains('checked') ? '☑ ' : '☐ '));
    if (node instanceof HTMLImageElement && node.dataset.copyDisplay === 'block')
      node.style.display = 'block';
    if (
      node instanceof HTMLAnchorElement &&
      !/^(https?:\/\/|mailto:|#)/i.test(node.getAttribute('href') || '')
    )
      node.removeAttribute('href');
    for (const attribute of [...node.attributes])
      if (
        attribute.name.startsWith('data-') ||
        ['class', 'contenteditable', 'tabindex'].includes(attribute.name)
      )
        node.removeAttribute(attribute.name);
  }
  const body = DOMPurify.sanitize(clone.innerHTML, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'style',
      'form',
      'input',
      'button',
      'iframe',
      'object',
      'embed',
      'video',
      'audio',
    ],
    FORBID_ATTR: ['srcset'],
  });
  const font = options.target === 'wechat' ? '16px' : '14px';
  const html = `<section style="font-family:Arial,'Noto Sans CJK SC',sans-serif;font-size:${font};line-height:1.8;color:#30343c;background-color:#ffffff;overflow-wrap:break-word">${body}</section>`;
  const imageCount = clone.querySelectorAll('img').length;
  return {
    html,
    text,
    title: options.title,
    target: options.target,
    imageCount,
    warnings: imageCount
      ? [
          '图片与图形以本地 PNG / 内嵌图片复制；目标平台可能过滤内嵌图片，必要时需手动插入。 · Images are embedded locally; the destination may require manual image insertion.',
        ]
      : [],
  };
}
/** Call directly from the user's Copy button, after preparation has finished. */
export async function writeRichClipboard(
  payload: Pick<RichClipboardPayload, 'html' | 'text'>,
): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([payload.html], { type: 'text/html' }),
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      /* Older Linux WebKit needs the synchronous clipboard event path. */
    }
  }
  let copied = false;
  const handler = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/html', payload.html);
    event.clipboardData.setData('text/plain', payload.text);
    event.preventDefault();
    copied = true;
  };
  document.addEventListener('copy', handler);
  try {
    if (typeof document.execCommand === 'function' && document.execCommand('copy') && copied)
      return;
  } finally {
    document.removeEventListener('copy', handler);
  }
  throw new Error(
    '系统未允许复制富文本，请重试或保存 HTML。 · Rich-text clipboard access failed. Retry or save HTML.',
  );
}
