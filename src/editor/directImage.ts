import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
  applyImageDimensions,
  imageDimension,
  parseImageMarkup,
  serializeImageMarkup,
  type ImageMarkup,
} from '../lib/imageMarkup';
import { t } from '../lib/i18n';
import { openImagePreview } from '../components/imagePreview';
import type { DirectBlockController } from './directTable';

export function attachDirectImage(
  view: EditorView,
  root: HTMLElement,
  initialRaw: string,
  initialPosition: number,
): DirectBlockController | null {
  let metadata = parseImageMarkup(initialRaw);
  const foundImage = root.querySelector('img');
  if (!metadata || !foundImage || root.querySelectorAll('img').length !== 1) return null;
  const image = foundImage;
  let raw = initialRaw;
  let position = initialPosition;
  let disposed = false;
  let selected = false;
  let closePreview: (() => void) | null = null;
  const frame = document.createElement('span');
  frame.className = 'direct-image-frame';
  image.before(frame);
  frame.append(image);
  image.tabIndex = 0;
  image.setAttribute('role', 'button');
  image.title = t('点击设置图片，双击预览', 'Click for image settings, double-click to preview');
  image.setAttribute('aria-label', t('设置图片尺寸', 'Set image size'));
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'direct-image-resize';
  handle.title = t('拖动等比缩放图片', 'Drag to resize image proportionally');
  handle.setAttribute('aria-label', handle.title);
  handle.tabIndex = -1;
  frame.append(handle);

  const tools = document.createElement('form');
  tools.className = 'direct-image-tools';
  tools.setAttribute('aria-label', t('图片尺寸工具', 'Image size controls'));
  const width = sizeInput(t('图片宽度', 'Image width'));
  const height = sizeInput(t('图片高度', 'Image height'));
  const lock = document.createElement('input');
  lock.type = 'checkbox';
  lock.checked = true;
  lock.setAttribute('aria-label', t('保持宽高比', 'Keep aspect ratio'));
  const lockLabel = document.createElement('label');
  lockLabel.className = 'direct-image-lock';
  lockLabel.title = t('保持宽高比', 'Keep aspect ratio');
  lockLabel.append(lock, document.createTextNode(t('等比', 'Ratio')));
  const times = document.createElement('span');
  times.textContent = '×';
  const apply = action('✓', t('应用图片尺寸', 'Apply image size'));
  apply.type = 'submit';
  const preview = action('⤢', t('预览大图', 'Preview full image'));
  const reset = action('↺', t('恢复原始尺寸', 'Reset image size'));
  const close = action('×', t('关闭图片工具', 'Close image controls'));
  const error = document.createElement('span');
  error.className = 'direct-image-error';
  error.setAttribute('role', 'status');
  tools.append(width, times, height, lockLabel, apply, preview, reset, close, error);
  const fields = document.createElement('div');
  fields.className = 'direct-image-fields';
  function textField(label: string) {
    const field = document.createElement('label');
    field.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('aria-label', label);
    field.append(input);
    fields.append(field);
    return input;
  }
  const source = textField(t('图片路径或网址', 'Image path or URL'));
  const caption = textField(t('图注', 'Caption'));
  const alt = textField(t('替代文字', 'Alternative text'));
  const alignment = document.createElement('select');
  alignment.setAttribute('aria-label', t('图片对齐', 'Image alignment'));
  for (const [value, label] of [
    ['', t('默认对齐', 'Default alignment')],
    ['left', t('左对齐', 'Align left')],
    ['center', t('居中', 'Center')],
    ['right', t('右对齐', 'Align right')],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    alignment.append(option);
  }
  fields.append(alignment);
  tools.append(fields);

  function sizeInput(label: string) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '10000';
    input.step = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', label);
    input.title = `${label} (px)`;
    input.placeholder = 'px';
    return input;
  }
  function action(symbol: string, label: string) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = symbol;
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
  }
  function ratio() {
    if (metadata?.width && metadata.height) return metadata.width / metadata.height;
    return image.naturalWidth && image.naturalHeight
      ? image.naturalWidth / image.naturalHeight
      : null;
  }
  function refresh() {
    applyImageDimensions(image);
    const aspect = ratio();
    width.value = String(
      metadata?.width ||
        (metadata?.height && aspect ? Math.round(metadata.height * aspect) : image.naturalWidth) ||
        '',
    );
    height.value = String(
      metadata?.height ||
        (metadata?.width && aspect ? Math.round(metadata.width / aspect) : image.naturalHeight) ||
        '',
    );
    preview.disabled = !image.getAttribute('src') || image.classList.contains('pending-image');
    handle.disabled = preview.disabled;
    source.value = metadata?.source || '';
    caption.value = metadata?.caption || '';
    alt.value = metadata?.alt || '';
    alignment.value = metadata?.alignment || '';
  }
  function place() {
    if (!selected) return;
    const rect = image.getBoundingClientRect();
    const toolbarWidth = tools.getBoundingClientRect().width || 365;
    const available = Math.max(8, window.innerWidth - toolbarWidth - 8);
    tools.style.left = `${Math.max(8, Math.min(available, rect.left))}px`;
    tools.style.top = `${Math.max(8, Math.min(window.innerHeight - tools.offsetHeight - 8, Math.max(48, rect.top - tools.offsetHeight - 8)))}px`;
  }
  function select() {
    if (disposed) return;
    if (!selected) {
      selected = true;
      frame.classList.add('is-selected');
      document.body.append(tools);
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      handle.tabIndex = 0;
    }
    refresh();
    place();
  }
  function deselect() {
    selected = false;
    frame.classList.remove('is-selected');
    tools.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    handle.tabIndex = -1;
  }
  function outside(event: Event) {
    const target = event.target as Node;
    if (!frame.contains(target) && !tools.contains(target)) deselect();
  }
  function save(nextWidth?: number, nextHeight?: number, details?: Partial<ImageMarkup>) {
    if (
      disposed ||
      !metadata ||
      view.state.doc.sliceString(position, position + raw.length) !== raw
    )
      return;
    let insert: string;
    try {
      insert = serializeImageMarkup(
        { ...metadata, ...details },
        { width: nextWidth, height: nextHeight },
      );
    } catch {
      error.textContent = t(
        '图片路径无效，请使用本地路径或 HTTP(S) 网址',
        'Use a local image path or HTTP(S) URL',
      );
      return;
    }
    if (insert === raw) return;
    view.dispatch({
      changes: { from: position, to: position + raw.length, insert },
      userEvent: 'input.format',
      annotations: isolateHistory.of('full'),
    });
    view.requestMeasure();
  }
  function applyInputs() {
    const w = width.value ? imageDimension(width.value) : undefined;
    const h = height.value ? imageDimension(height.value) : undefined;
    if ((width.value && !w) || (height.value && !h)) {
      error.textContent = t('尺寸范围为 1–10000 px', 'Use a size between 1 and 10000 px');
      return;
    }
    error.textContent = '';
    save(w, h, {
      source: source.value.trim(),
      caption: caption.value,
      alt: alt.value,
      alignment: (alignment.value as ImageMarkup['alignment']) || undefined,
    });
  }
  function synchronize(axis: 'width' | 'height') {
    if (!lock.checked) return;
    const aspect = ratio();
    const value = imageDimension(axis === 'width' ? width.value : height.value);
    if (!aspect || !value) return;
    const paired = Math.round(axis === 'width' ? value / aspect : value * aspect);
    (axis === 'width' ? height : width).value = String(paired);
  }
  width.addEventListener('input', () => synchronize('width'));
  height.addEventListener('input', () => synchronize('height'));
  tools.addEventListener('submit', (event) => {
    event.preventDefault();
    applyInputs();
  });
  tools.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      deselect();
      image.focus();
    }
  });
  preview.addEventListener('click', () => {
    closePreview = openImagePreview(image);
  });
  reset.addEventListener('click', () => save());
  close.addEventListener('click', deselect);
  image.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    select();
  });
  image.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    select();
  });
  image.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePreview = openImagePreview(image);
  });
  image.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    select();
    width.focus();
  });
  image.addEventListener('load', () => {
    refresh();
    view.requestMeasure();
    place();
  });

  let drag: {
    x: number;
    width: number;
    ratio: number;
    targetWidth: number;
    targetHeight: number;
  } | null = null;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = image.getBoundingClientRect();
    const aspect = ratio() || (rect.height ? rect.width / rect.height : 1);
    if (!rect.width) return;
    drag = {
      x: event.clientX,
      width: rect.width,
      ratio: aspect,
      targetWidth: Math.round(rect.width),
      targetHeight: Math.round(rect.width / aspect),
    };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const w = Math.max(1, Math.min(10000, Math.round(drag.width + event.clientX - drag.x)));
    const h = Math.max(1, Math.min(10000, Math.round(w / drag.ratio)));
    drag.targetWidth = w;
    drag.targetHeight = h;
    image.style.width = `${w}px`;
    image.style.height = 'auto';
    image.style.aspectRatio = `${w} / ${h}`;
    width.value = String(w);
    height.value = String(h);
    view.requestMeasure();
    place();
  });
  handle.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const { targetWidth, targetHeight } = drag;
    drag = null;
    handle.releasePointerCapture?.(event.pointerId);
    save(targetWidth, targetHeight);
    refresh();
  });
  handle.addEventListener('pointercancel', () => {
    drag = null;
    refresh();
  });
  handle.addEventListener('lostpointercapture', () => {
    if (drag) {
      drag = null;
      refresh();
    }
  });
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const currentWidth = metadata?.width || image.naturalWidth || 100;
    const next = Math.max(
      1,
      Math.min(10000, currentWidth + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -10 : 10)),
    );
    const aspect = ratio();
    save(next, aspect ? Math.max(1, Math.min(10000, Math.round(next / aspect))) : undefined);
  });
  refresh();
  return {
    update(nextRaw, _path, nextPosition) {
      const next = parseImageMarkup(nextRaw);
      if (
        !next ||
        next.source !== metadata?.source ||
        next.caption !== metadata?.caption ||
        next.alignment !== metadata?.alignment
      )
        return false;
      raw = nextRaw;
      position = nextPosition;
      metadata = next;
      image.alt = next.alt;
      for (const key of ['width', 'height'] as const) {
        if (next[key]) image.setAttribute(key, String(next[key]));
        else image.removeAttribute(key);
      }
      refresh();
      place();
      return true;
    },
    destroy() {
      disposed = true;
      closePreview?.();
      deselect();
    },
  };
}
