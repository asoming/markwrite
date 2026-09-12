import { hydrateDiagrams } from './markdown';
import { assetData, desktop } from './platform';
import { invoke } from '@tauri-apps/api/core';
import { applyImageDimensions } from './imageMarkup';
import { t } from './i18n';
import { readingPattern } from './readingSearch';

/** Mark text ranges without replacing the document's links, images or event listeners. */
export function highlightReadingMatches(
  root: HTMLElement,
  query: string,
  active: number,
  caseSensitive = false,
) {
  for (const mark of root.querySelectorAll('mark.reading-match'))
    mark.replaceWith(...mark.childNodes);
  root.normalize();
  const pattern = readingPattern(query, caseSensitive);
  if (!pattern) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('button,svg,script,style,[data-reading-repeat]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: { node: Text; from: number; to: number }[] = [];
  let text = '';
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, from: text.length, to: text.length + node.length });
    text += node.data;
  }
  const matches = [...text.matchAll(pattern)];
  let nodeIndex = nodes.length - 1;
  // Descending ranges keep every captured Text node offset valid after splitText.
  for (let index = matches.length - 1; index >= 0; index--) {
    const from = matches[index].index!,
      to = from + matches[index][0].length;
    while (nodeIndex >= 0 && nodes[nodeIndex].from >= to) nodeIndex--;
    for (let n = nodeIndex; n >= 0 && nodes[n].to > from; n--) {
      const item = nodes[n],
        start = Math.max(0, from - item.from),
        end = Math.min(item.node.length, to - item.from);
      if (end <= start) continue;
      const part = item.node.splitText(start);
      part.splitText(end - start);
      const mark = document.createElement('mark');
      mark.className = `reading-match${index === active ? ' active' : ''}`;
      mark.dataset.readingMatch = String(index);
      part.replaceWith(mark);
      mark.append(part);
    }
  }
}

export type ReadingAssets = { allowedRemote: Set<string>; cache: Map<string, string> };
/** Only visible assets do I/O. Consent is scoped to this open document, not persisted globally. */
export function observeReadingAssets(
  root: HTMLElement,
  viewport: HTMLElement,
  path: string | undefined,
  assets: ReadingAssets,
  preview: (image: HTMLImageElement) => void,
) {
  let disposed = false;
  for (const checkbox of root.querySelectorAll('.task-check'))
    checkbox.setAttribute(
      'aria-label',
      checkbox.classList.contains('checked') ? t('已完成', 'Complete') : t('未完成', 'Incomplete'),
    );
  const abort = new AbortController();
  const started = new WeakSet<Element>();
  const buttons: HTMLButtonElement[] = [];
  const activate = (element: Element) => {
    if (disposed || started.has(element)) return;
    started.add(element);
    if (element.matches('[data-diagram]')) {
      void hydrateDiagrams(element as HTMLElement);
      return;
    }
    const img = element as HTMLImageElement;
    const source = img.dataset.asset || '';
    if (!source) return;
    if (/^https?:\/\//i.test(source)) {
      let hostname: string;
      try {
        hostname = new URL(source).hostname;
      } catch {
        img.title = t('图片地址无效，请编辑链接地址。');
        return;
      }
      const button = document.createElement('button');
      button.className = 'remote-image-load';
      buttons.push(button);
      button.textContent = t('加载网络图片（将访问 {0}）', undefined, [hostname]);
      const load = () => {
        assets.allowedRemote.add(source);
        img.referrerPolicy = 'no-referrer';
        img.src = source;
        img.onload = () => {
          img.classList.remove('pending-image');
          applyImageDimensions(img);
          button.remove();
        };
        img.onerror = () => {
          button.textContent = t('图片加载失败，点击重试');
          if (!button.isConnected && !disposed) img.after(button);
        };
      };
      button.addEventListener('click', load, { signal: abort.signal });
      img.after(button);
      if (assets.allowedRemote.has(source)) load();
      return;
    }
    if (!path) {
      img.title = t('图片需要打开原文件夹后才能显示');
      return;
    }
    const acceptSource = (src: string) => {
      if (disposed) return;
      // A single large image may be shown, but it must not leave a giant cache behind.
      if (src.length <= 8 * 1024 * 1024) {
        assets.cache.set(source, src);
        let size = [...assets.cache.values()].reduce((sum, value) => sum + value.length, 0);
        for (const [key, value] of assets.cache) {
          if (size <= 16 * 1024 * 1024) break;
          assets.cache.delete(key);
          size -= value.length;
        }
      }
      img.src = src;
      img.classList.remove('pending-image');
    };
    const cached = assets.cache.get(source);
    const reading = cached ? Promise.resolve(cached) : assetData(path, source);
    void reading.then(acceptSource).catch((error) => {
      if (disposed) return;
      img.title = t('图片不可用或未授权加载');
      if (!desktop) return;
      const button = document.createElement('button');
      button.className = 'remote-image-load local-image-authorize';
      button.textContent = t('选择附件所在文件夹…', 'Choose the attachment folder…');
      button.title = String(error);
      buttons.push(button);
      img.after(button);
      button.addEventListener(
        'click',
        async () => {
          button.disabled = true;
          try {
            const selected = await invoke<string | null>('authorize_asset_folder');
            if (!selected || disposed) return;
            acceptSource(await assetData(path, source));
            button.remove();
          } catch (failure) {
            if (!disposed) {
              button.textContent = t(
                '图片仍不可用，重新选择文件夹…',
                'Image unavailable. Choose another folder…',
              );
              button.title = String(failure);
            }
          } finally {
            button.disabled = false;
          }
        },
        { signal: abort.signal },
      );
    });
  };
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const item of entries)
              if (item.isIntersecting) {
                observer?.unobserve(item.target);
                activate(item.target);
              }
          },
          { root: viewport, rootMargin: '160px 0px' },
        );
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    applyImageDimensions(img);
    img.loading = 'lazy';
    img.tabIndex = 0;
    img.title = t('点击预览大图', 'Click to preview full image');
    img.addEventListener('load', () => applyImageDimensions(img), { signal: abort.signal });
    img.addEventListener(
      'keydown',
      (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        preview(img);
      },
      { signal: abort.signal },
    );
  }
  for (const node of root.querySelectorAll('img[data-asset],[data-diagram]')) {
    if (observer) observer.observe(node);
    else activate(node);
  }
  return () => {
    disposed = true;
    abort.abort();
    observer?.disconnect();
    for (const button of buttons) button.remove();
  };
}

export function findReadingText(root: HTMLElement, query: string) {
  const needle = query.trim();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text,
      at = node.data.indexOf(needle);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    return range;
  }
  return null;
}
