import { useEffect, useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import {
  importDocument,
  importLimit,
  type ImportedDocument,
  type ImportSource,
} from '../lib/importDocument';
import { chooseImportFiles } from '../lib/nativeSettings';
import { assetData, desktop } from '../lib/platform';
import './import.css';

export default function ImportPanel({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (documents: ImportedDocument[]) => void;
}) {
  const { t } = useI18n();
  const [documents, setDocuments] = useState<ImportedDocument[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      generation.current++;
      previous?.focus();
    };
  }, []);
  async function convert(sources: ImportSource[], token: number) {
    if (
      sources.length > 16 ||
      sources.reduce((sum, file) => sum + file.bytes.length, 0) > importLimit * 2
    )
      throw new Error(
        t(
          '一次最多导入 16 个文件，总大小不能超过 64 MiB。',
          'Import up to 16 files, totaling no more than 64 MiB.',
        ),
      );
    const converted: ImportedDocument[] = [];
    const failed: string[] = [];
    for (const source of sources) {
      if (token !== generation.current) return;
      try {
        converted.push(await importDocument(source, desktop ? assetData : undefined));
      } catch (error) {
        failed.push(`${source.name}: ${String(error).replace(/^Error: /, '')}`);
      }
    }
    if (token !== generation.current) return;
    setDocuments(converted);
    setErrors(failed);
    setSelected(0);
  }
  async function pick(files?: FileList | null) {
    const token = ++generation.current;
    setBusy(true);
    setErrors([]);
    try {
      let sources: ImportSource[];
      if (desktop)
        sources = (await chooseImportFiles()).map((file) => ({
          ...file,
          bytes: Uint8Array.from(file.bytes),
        }));
      else {
        const list = [...(files || [])];
        if (
          list.length > 16 ||
          list.some((file) => file.size > importLimit) ||
          list.reduce((sum, file) => sum + file.size, 0) > importLimit * 2
        )
          throw new Error(
            t(
              '一次最多 16 个文件，每个不超过 32 MiB，总计不超过 64 MiB。',
              'Choose up to 16 files, at most 32 MiB each and 64 MiB total.',
            ),
          );
        sources = await Promise.all(
          list.map(async (file) => ({
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        );
      }
      if (sources.length) await convert(sources, token);
    } catch (error) {
      if (token === generation.current) {
        setDocuments([]);
        setErrors([String(error).replace(/^Error: /, '')]);
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  const current = documents[selected];
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal wide import-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('导入文档', 'Import documents')}
        ref={panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key !== 'Tab') return;
          const focusable = panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),select,input:not([hidden]),[tabindex="0"]',
          );
          if (!focusable?.length) return;
          const first = focusable[0],
            last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-heading">
          <div>
            <h2>{t('导入文档', 'Import documents')}</h2>
            <p>
              {t(
                '将其他格式转换为 Markdown 草稿，原文件保持不变。',
                'Convert other formats into Markdown drafts. Source files are preserved.',
              )}
            </p>
          </div>
          <button onClick={onClose} aria-label={t('关闭', 'Close')}>
            <X size={18} />
          </button>
        </div>
        <div className="import-select">
          <FileUp size={28} />
          <div>
            <strong>TXT · HTML · DOCX</strong>
            <p>
              {t(
                '支持标题、段落、列表、表格、链接与图片。复杂版式会转换为简洁的文档结构。',
                'Headings, paragraphs, lists, tables, links and images are supported. Complex layouts become a simpler document structure.',
              )}
            </p>
          </div>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => (desktop ? void pick() : input.current?.click())}
          >
            {busy ? t('正在转换…', 'Converting…') : t('选择文件', 'Choose files')}
          </button>
          <input
            ref={input}
            type="file"
            accept=".txt,.html,.htm,.docx"
            multiple
            hidden
            onChange={(event) => {
              void pick(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        <p className="import-note">
          {t(
            '文本请使用 UTF-8 或带 BOM 的 UTF-16 编码。每个文件最多 32 MiB；一次最多 16 个、合计 64 MiB。',
            'Text must use UTF-8 or UTF-16 with a BOM. Up to 32 MiB per file, 16 files and 64 MiB per batch.',
          )}
        </p>
        {errors.length > 0 && (
          <div className="import-errors" role="alert">
            <strong>{t('以下文件未能导入', 'These files could not be imported')}</strong>
            {errors.map((error, index) => (
              <p key={index}>{error}</p>
            ))}
          </div>
        )}
        {current && (
          <div className="import-preview">
            <label>
              {t('转换预览', 'Conversion preview')}
              <select
                value={selected}
                onChange={(event) => setSelected(Number(event.target.value))}
              >
                {documents.map((item, index) => (
                  <option key={index} value={index}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <pre tabIndex={0}>
              {current.content.slice(0, 12_000)}
              {current.content.length > 12_000 ? '\n…' : ''}
            </pre>
            {current.warnings.length > 0 && (
              <details>
                <summary>
                  {t('转换提示（{0}）', 'Conversion notes ({0})', [current.warnings.length])}
                </summary>
                {current.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </details>
            )}
          </div>
        )}
        <div className="import-actions">
          <button onClick={onClose}>{t('取消', 'Cancel')}</button>
          <button
            className="primary-button"
            disabled={busy || !documents.length}
            onClick={() => onImport(documents)}
          >
            {t('导入为 Markdown（{0}）', 'Import as Markdown ({0})', [documents.length])}
          </button>
        </div>
      </div>
    </div>
  );
}
