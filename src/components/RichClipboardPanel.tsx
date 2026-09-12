import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileDown, LoaderCircle } from 'lucide-react';
import {
  prepareRichClipboard,
  writeRichClipboard,
  type RichClipboardPayload,
  type RichClipboardTarget,
} from '../lib/richClipboard';
import { exportHtml } from '../lib/platform';
import './rich-clipboard.css';
export type RichClipboardPanelProps = {
  title: string;
  language: 'zh-CN' | 'en';
  sourceKey: string;
  prepareArticle: () => Promise<HTMLElement>;
  onClose?: () => void;
};
export default function RichClipboardPanel({
  title,
  language,
  sourceKey,
  prepareArticle,
}: RichClipboardPanelProps) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh);
  const [target, setTarget] = useState<RichClipboardTarget>('wechat');
  const [result, setResult] = useState<{ key: string; payload: RichClipboardPayload }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const current = useRef(0);
  const prepare = useRef(prepareArticle);
  prepare.current = prepareArticle;
  const key = JSON.stringify([sourceKey, title, target]);
  const payload = result?.key === key ? result.payload : undefined;
  useEffect(() => {
    const generation = ++current.current;
    setBusy(true);
    setError('');
    setCopied(false);
    void prepare
      .current()
      .then((article) => prepareRichClipboard(article, { target, title }))
      .then((prepared) => {
        if (generation === current.current) setResult({ key, payload: prepared });
      })
      .catch((reason) => {
        if (generation === current.current)
          setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (generation === current.current) setBusy(false);
      });
    return () => {
      current.current++;
    };
  }, [key, target, title]);
  const copy = async () => {
    if (!payload) return;
    setError('');
    const generation = current.current;
    try {
      await writeRichClipboard(payload);
      if (current.current === generation) setCopied(true);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };
  const save = async () => {
    if (!payload) return;
    try {
      await exportHtml(
        `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&]/g, '')}</title></head><body>${payload.html}</body></html>`,
        `${title.replace(/\.(md|markdown)$/i, '')}.html`,
      );
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    }
  };
  return (
    <div className="rich-clipboard-panel">
      <div
        className="rich-clipboard-targets"
        role="group"
        aria-label={t('粘贴目标', 'Paste destination')}
      >
        <button aria-pressed={target === 'wechat'} onClick={() => setTarget('wechat')}>
          {t('微信公众号', 'WeChat article')}
        </button>
        <button aria-pressed={target === 'feishu'} onClick={() => setTarget('feishu')}>
          {t('飞书文档', 'Feishu document')}
        </button>
      </div>
      <p className="rich-clipboard-hint">
        {t(
          '在本机准备正文和排版，复制后直接粘贴到目标编辑器。不会上传图片或打开目标网站。',
          'Prepare content and formatting locally, then paste into the destination editor. Images are never uploaded and no destination website is opened.',
        )}
      </p>
      {busy && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> {t('正在准备富文本…', 'Preparing rich text…')}
        </p>
      )}
      {payload && (
        <>
          {payload.warnings.map((warning) => (
            <p key={warning} className="rich-clipboard-hint">
              {warning}
            </p>
          ))}
          <div
            className="rich-clipboard-preview"
            aria-label={t('复制内容预览', 'Clipboard preview')}
            dangerouslySetInnerHTML={{ __html: payload.html }}
            onClick={(event) => {
              if ((event.target as Element).closest('a')) event.preventDefault();
            }}
          />
          <div className="rich-clipboard-actions">
            <button className="primary" onClick={() => void copy()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied
                ? t('已复制，可以粘贴', 'Copied — ready to paste')
                : t('复制富文本', 'Copy rich text')}
            </button>
            <button onClick={() => void save()}>
              <FileDown size={16} />
              {t('保存 HTML', 'Save HTML')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="rich-clipboard-error">
          {error}
        </p>
      )}
    </div>
  );
}
