import { useEffect, useRef, useMemo } from 'react';
import { renderMarkdown, hydrateDiagrams } from './lib/markdown';
import { assetData } from './lib/platform';
export default function Reader({
  content,
  path,
  onLink,
}: {
  content: string;
  path?: string;
  onLink: (href: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let cancelled = false;
    void hydrateDiagrams(root);
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-asset]')) {
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
  }, [html, path]);
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
          if (href.startsWith('#')) {
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
