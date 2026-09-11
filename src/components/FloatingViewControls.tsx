import { BookOpen, Code2, Focus, Minimize, Pencil } from 'lucide-react';
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useI18n } from '../lib/i18n';
import type { Mode } from '../lib/types';
import './floatingViewControls.css';

type Props = {
  mode: Mode;
  onMode: (mode: Mode) => void;
  focus: boolean;
  onFocus: () => void;
  transparency: number;
  disabled?: boolean;
};

const modes = [
  { mode: 'read', label: '阅读模式', english: 'Reading mode', icon: BookOpen },
  { mode: 'live', label: '编辑模式', english: 'Editing mode', icon: Pencil },
  { mode: 'source', label: '源码模式', english: 'Source mode', icon: Code2 },
] as const;

export default function FloatingViewControls({
  mode,
  onMode,
  focus,
  onFocus,
  transparency,
  disabled = false,
}: Props) {
  const { t } = useI18n();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [tabStop, setTabStop] = useState(() => modes.findIndex((item) => item.mode === mode));
  const focusLabel = focus
    ? t('退出专注模式', 'Exit focus mode')
    : t('进入专注模式', 'Enter focus mode');
  const visibility =
    1 - Math.min(80, Math.max(0, Number.isFinite(transparency) ? transparency : 15)) / 100;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const available = disabled ? [3] : [0, 1, 2, 3];
    const current = available.indexOf(buttons.current.indexOf(event.target as HTMLButtonElement));
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = available[(current + 1) % available.length];
        break;
      case 'ArrowLeft':
        next = available[(current + available.length - 1) % available.length];
        break;
      case 'Home':
        next = available[0];
        break;
      case 'End':
        next = available[available.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.current[next]?.focus();
  }

  return (
    <div
      className={`floating-view-region${focus ? ' is-focused' : ''}`}
      style={{ '--view-controls-opacity': visibility } as CSSProperties}
    >
      <div
        className="floating-view-controls"
        role="toolbar"
        aria-label={t('阅读与编辑工具', 'Reading and editing controls')}
        onKeyDown={navigate}
        onMouseDown={(event) => {
          // Pointer actions should not move the editor's selection or retain focus here.
          if (event.button === 0) event.preventDefault();
        }}
      >
        {modes.map(({ mode: value, label, english, icon: Icon }, index) => (
          <button
            key={value}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            aria-label={t(label, english)}
            title={t(label, english)}
            aria-pressed={mode === value}
            disabled={disabled}
            tabIndex={!disabled && tabStop === index ? 0 : -1}
            onFocus={() => setTabStop(index)}
            onClick={() => onMode(value)}
          >
            <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
          </button>
        ))}
        <span className="floating-view-divider" aria-hidden="true" />
        <button
          ref={(button) => {
            buttons.current[3] = button;
          }}
          type="button"
          aria-label={focusLabel}
          title={focusLabel}
          aria-pressed={focus}
          tabIndex={disabled || tabStop === 3 ? 0 : -1}
          onFocus={() => setTabStop(3)}
          onClick={onFocus}
        >
          {focus ? (
            <Minimize size={17} strokeWidth={1.7} aria-hidden="true" />
          ) : (
            <Focus size={17} strokeWidth={1.7} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
