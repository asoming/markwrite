import { Lexer, Parser } from 'marked';

export type ImageMarkup = {
  source: string;
  alt: string;
  title?: string;
  width?: number;
  height?: number;
};

/** Only finite pixel dimensions are shared between the editor and document exporters. */
export function imageDimension(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 10_000) return;
  return Math.round(number);
}

function safeSource(value: string): boolean {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[a-z]:[\\/]/i.test(value)) return true;
  if (/^data:/i.test(value))
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value);
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(value.trim());
  return !protocol || /^(https?|file)$/i.test(protocol[1]);
}

/** Reads one standalone image, without attaching HTML or fetching its source. */
export function parseImageMarkup(raw: string): ImageMarkup | null {
  const source = raw.trim();
  if (!/^(?:!\[|<img\b)/i.test(source)) return null;
  if (/^<img\b/i.test(source)) {
    const template = document.createElement('template');
    template.innerHTML = source;
    const nodes = [...template.content.childNodes].filter(
      (node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
    );
    if (nodes.length !== 1 || !(nodes[0] instanceof HTMLImageElement)) return null;
    const image = nodes[0];
    const url = image.getAttribute('src') || '';
    if (!safeSource(url)) return null;
    return {
      source: url,
      alt: image.getAttribute('alt') || '',
      title: image.getAttribute('title') || undefined,
      width: imageDimension(image.getAttribute('width')),
      height: imageDimension(image.getAttribute('height')),
    };
  }
  const tokens = Lexer.lexInline(source);
  if (tokens.length !== 1 || tokens[0].type !== 'image' || tokens[0].raw !== source) return null;
  const image = tokens[0];
  if (!safeSource(image.href)) return null;
  const template = document.createElement('template');
  template.innerHTML = Parser.parseInline(tokens);
  const rendered = template.content.querySelector('img');
  const url = rendered?.getAttribute('src') || image.href;
  if (!safeSource(url)) return null;
  return {
    source: url,
    alt: rendered?.alt ?? image.text,
    title: rendered?.getAttribute('title') || undefined,
  };
}

/** Called only after an explicit size edit; untouched Markdown remains byte-for-byte intact. */
export function serializeImageMarkup(
  image: ImageMarkup,
  dimensions: { width?: number; height?: number } = image,
): string {
  if (!safeSource(image.source)) throw new Error('Invalid image source');
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character]!,
    );
  const width = imageDimension(dimensions.width);
  const height = imageDimension(dimensions.height);
  return `<img src="${escape(image.source)}" alt="${escape(image.alt)}"${image.title ? ` title="${escape(image.title)}"` : ''}${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`;
}

/** Fit explicit dimensions into the reading column without losing their saved aspect ratio. */
export function applyImageDimensions(image: HTMLImageElement) {
  const width = imageDimension(image.getAttribute('width'));
  const height = imageDimension(image.getAttribute('height'));
  image.style.removeProperty('width');
  image.style.removeProperty('height');
  image.style.removeProperty('aspect-ratio');
  if (width) image.style.width = `${width}px`;
  if (width && height) image.style.aspectRatio = `${width} / ${height}`;
  if (width || !height) image.style.height = 'auto';
  else if (image.naturalWidth && image.naturalHeight) {
    image.style.width = `${Math.round((height * image.naturalWidth) / image.naturalHeight)}px`;
    image.style.height = 'auto';
  } else image.style.height = `${height}px`;
}
