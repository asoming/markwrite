import { t } from '../lib/i18n';

let closeCurrent: (() => void) | null = null;

/** A preview uses only an image the document has already loaded with user authorization. */
export function openImagePreview(source: HTMLImageElement): (() => void) | null {
  const url = source.currentSrc || source.getAttribute('src');
  if (!url || source.classList.contains('pending-image')) return null;
  closeCurrent?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement('div');
  backdrop.className = 'image-preview-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', t('图片预览', 'Image preview'));
  const image = document.createElement('img');
  image.alt = source.alt;
  image.referrerPolicy = 'no-referrer';
  image.src = url;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'image-preview-close';
  close.textContent = '×';
  close.title = t('关闭图片预览', 'Close image preview');
  close.setAttribute('aria-label', close.title);
  const caption = document.createElement('div');
  caption.className = 'image-preview-caption';
  caption.textContent = source.alt;
  let closed = false;
  function dismiss() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', keyboard, true);
    backdrop.remove();
    if (closeCurrent === dismiss) closeCurrent = null;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else if (source.isConnected) source.focus({ preventScroll: true });
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close.focus();
    }
  }
  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) dismiss();
  });
  backdrop.append(image, caption, close);
  document.body.append(backdrop);
  document.addEventListener('keydown', keyboard, true);
  closeCurrent = dismiss;
  close.focus();
  return dismiss;
}
