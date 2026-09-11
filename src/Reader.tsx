import { useEffect, useRef, useMemo } from 'react';
import { renderMarkdown, hydrateDiagrams } from './lib/markdown';
import { assetData } from './lib/platform';
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
  theme?: string;
  revision?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content, revision]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = html;
    let cancelled = false;
    void hydrateDiagrams(root);
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
      const source = img.dataset.asset || '';
      if (/^https?:\/\//i.test(source)) {
        let hostname: string;
        try {
          hostname = new URL(source).hostname;
        } catch {
          img.title = '图片地址无效，请编辑链接地址。';
          continue;
        }
        const button = document.createElement('button');
        button.className = 'remote-image-load';
        button.textContent = `加载网络图片（将访问 ${hostname}）`;
        button.onclick = () => {
          img.referrerPolicy = 'no-referrer';
          img.src = source;
          img.onload = () => {
            img.classList.remove('pending-image');
            button.remove();
          };
          img.onerror = () => {
            button.textContent = '图片加载失败，点击重试';
          };
        };
        img.after(button);
        continue;
      }
      if (!path) {
        img.title = '图片需要打开原文件夹后才能显示';
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
          img.title = '图片不可用或未授权加载';
        });
    }
    return () => {
      cancelled = true;
    };
  }, [html, path, theme]);
  return (
    <div className="reader-scroll">
      <article
        className="markdown-body reader"
        ref={ref}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
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
