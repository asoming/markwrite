import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../lib/i18n';

export function useNarrowLayout(sidebarWidth: number) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = matchMedia(`(max-width: ${sidebarWidth + 560}px)`);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [sidebarWidth]);
  return narrow;
}

export function ResponsiveSidebar({
  overlay,
  onDismiss,
  children,
}: {
  overlay: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [overlay]);
  return (
    <>
      {overlay && (
        <button
          tabIndex={-1}
          className="sidebar-backdrop"
          aria-label={t('收起侧栏', 'Close sidebar')}
          onClick={onDismiss}
        />
      )}
      <aside
        ref={ref}
        className={`sidebar${overlay ? ' sidebar-overlay' : ''}`}
        role={overlay ? 'dialog' : undefined}
        aria-modal={overlay || undefined}
        aria-label={t('文件导航', 'File navigation')}
        onKeyDown={(event) => {
          if (!overlay) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss.current();
          }
          if (event.key === 'Tab') {
            const elements = [
              ...(ref.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input,select,[tabindex="0"],textarea',
              ) || []),
            ].filter((node) => node.getClientRects().length);
            const first = elements[0],
              last = elements.at(-1);
            if (
              first &&
              last &&
              ((event.shiftKey && document.activeElement === first) ||
                (!event.shiftKey && document.activeElement === last))
            ) {
              event.preventDefault();
              (event.shiftKey ? last : first).focus();
            }
          }
        }}
      >
        {children}
      </aside>
    </>
  );
}
