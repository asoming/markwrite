import { invoke, isTauri } from '@tauri-apps/api/core';

const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
export function normalizeImageFile(file: File): File | null {
  const type =
    file.type.toLowerCase() ||
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
      } as Record<string, string>
    )[file.name.split('.').pop()!.toLowerCase()];
  const extension = extensions[type];
  if (!extension) return null;
  const name = /\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)
    ? file.name.replace(/\.[^.]+$/, '.' + extension)
    : (file.name || 'pasted-image') + '.' + extension;
  return new File([file], name, { type });
}
export function transferredImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files || [])) {
    const normalized = normalizeImageFile(file);
    if (normalized) return normalized;
  }
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) {
      const normalized = normalizeImageFile(file);
      if (normalized) return normalized;
    }
  }
  return null;
}
/** Only called by a user paste gesture; never a timer or startup hook. */
export async function nativeClipboardImage(): Promise<File | null> {
  if (!isTauri()) return null;
  const value = await invoke<{ name: string; mime: string; data: string } | null>(
    'read_clipboard_image',
  );
  if (!value) return null;
  const bytes = Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0));
  return normalizeImageFile(new File([bytes], value.name, { type: value.mime }));
}

/** Image-only HTML from browsers is another clipboard encoding of the same bitmap. */
export function htmlClipboardImage(html: string): File | null {
  if (!html || !/<img\b/i.test(html)) return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = template.content.querySelectorAll('img');
  if (images.length !== 1 || template.content.textContent?.trim()) return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([a-z\d+/=\s]+)$/i.exec(
    images[0].getAttribute('src') || '',
  );
  if (!match || match[2].length > 28 * 1024 * 1024) return null;
  try {
    const bytes = Uint8Array.from(atob(match[2].replace(/\s/g, '')), (c) => c.charCodeAt(0));
    return normalizeImageFile(new File([bytes], 'pasted-image', { type: match[1] }));
  } catch {
    return null;
  }
}
