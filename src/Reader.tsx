import { t, useI18n } from './lib/i18n';
import { useEffect, useRef, useMemo } from 'react';
import { renderMarkdown, hydrateDiagrams } from './lib/markdown';
import type { Theme } from './lib/types';
import { assetData } from './lib/platform';
import { applyImageDimensions } from './lib/imageMarkup';
import { openImagePreview } from './components/imagePreview';
import './editor/directEditing.css';
export default function Reader({
  content,
  path,
  onLink,
  theme,
  revision,
}: {
  content: string;
  path?: string;
  onLink: (href: string) => void;
  theme?: Theme;
  revision?: number;
}) {
  const { language } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const closePreview = useRef<(() => void) | null>(null);
  const html = useMemo(() => renderMarkdown(content), [content, revision, language]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = html;
    for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
      applyImageDimensions(img);
      img.addEventListener('load', () => applyImageDimensions(img));
      img.tabIndex = 0;
      img.title = t('点击预览大图', 'Click to preview full image');
      img.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        closePreview.current = openImagePreview(img);
      });
    }
    let cancelled = false;
    void hydrateDiagrams(root);
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
      const source = img.dataset.asset || '';
      if (/^https?:\/\//i.test(source)) {
        let hostname: string;
        try {
          hostname = new URL(source).hostname;
        } catch {
          img.title = t('图片地址无效，请编辑链接地址。');
          continue;
        }
        const button = document.createElement('button');
        button.className = 'remote-image-load';
        button.textContent = t('加载网络图片（将访问 {0}）', undefined, [hostname]);
        button.onclick = () => {
          img.referrerPolicy = 'no-referrer';
          img.src = source;
          img.onload = () => {
            img.classList.remove('pending-image');
            button.remove();
          };
          img.onerror = () => {
            button.textContent = t('图片加载失败，点击重试');
          };
        };
        img.after(button);
        continue;
      }
      if (!path) {
        img.title = t('图片需要打开原文件夹后才能显示');
        continue;
      }
      void assetData(path, img.dataset.asset!)
        .then((src) => {
          if (!cancelled) {
            img.src = src;
            img.classList.remove('pending-image');
          }
        })
        .catch(() => {
          img.title = t('图片不可用或未授权加载');
        });
    }
    return () => {
      cancelled = true;
      closePreview.current?.();
      closePreview.current = null;
    };
  }, [html, path, theme, language]);
  return (
    <div className="reader-scroll">
      <article
        className="markdown-body reader"
        ref={ref}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const image = (e.target as HTMLElement).closest('img');
          if (image && !image.closest('a')) {
            e.preventDefault();
            closePreview.current = openImagePreview(image);
            return;
          }
          const anchor = (e.target as HTMLElement).closest('a');
          if (!anchor) return;
          e.preventDefault();
          const href = anchor.getAttribute('href') || '';
          if (href.startsWith('#wiki:')) onLink(href);
          else if (href.startsWith('#')) {
            try {
              ref.current
                ?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            } catch {
              /* malformed anchors are inert */
            }
          } else onLink(href);
        }}
      />
    </div>
  );
}
