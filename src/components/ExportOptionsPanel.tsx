import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, FileDown, LoaderCircle } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import {
  buildPdf,
  collectExportBlocks,
  exportPageLayout,
  saveExportBytes,
  type ExportOptions,
} from '../lib/export';
import './export-options.css';

export type ExportPanelOptions = ExportOptions & { theme?: string };
export type ExportOptionsPanelProps = {
  format: 'html' | 'pdf' | 'docx';
  value: ExportPanelOptions;
  onChange: (options: ExportPanelOptions) => void;
  title: string;
  language: 'zh-CN' | 'en';
  prepareArticle: () => Promise<HTMLElement>;
  /** Document identity and content revision; invalidates any generated preview. */
  sourceKey: string;
  busy?: boolean;
};

export default function ExportOptionsPanel({
  format,
  value,
  onChange,
  title,
  language,
  prepareArticle,
  sourceKey,
  busy = false,
}: ExportOptionsPanelProps) {
  const t = (zh: string, en: string) => (language === 'en' ? en : zh);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewResult, setPreviewResult] = useState<{
    key: string;
    pdf: PDFDocumentProxy;
    bytes: Uint8Array;
  }>();
  const [pageNumber, setPageNumber] = useState(1);
  const [rendering, setRendering] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const generation = useRef(0);
  const activePdf = useRef<PDFDocumentProxy | undefined>(undefined);
  const previewKey = JSON.stringify([value, sourceKey, title, language, format]);
  // Hide obsolete bytes during render, before asynchronous effect cleanup can run.
  const currentPreview = previewResult?.key === previewKey ? previewResult : undefined;
  const pdf = currentPreview?.pdf;
  const bytes = currentPreview?.bytes;
  const update = (patch: Partial<ExportPanelOptions>) => onChange({ ...value, ...patch });
  const margins = value.margins || exportPageLayout({ template: value.template }).margins;

  useEffect(() => {
    generation.current++;
    setGenerating(false);
    setPreviewResult(undefined);
    setError('');
    setNotice('');
    if (activePdf.current) {
      void activePdf.current.loadingTask.destroy();
      activePdf.current = undefined;
    }
    return () => {
      generation.current++;
    };
  }, [previewKey]);

  useEffect(
    () => () => {
      if (activePdf.current) void activePdf.current.loadingTask.destroy();
    },
    [],
  );

  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    const element = canvas.current;
    setRendering(true);
    void pdf
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        // Render the actual PDF at a readable resolution; CSS fits it to the panel.
        const scaled = page.getViewport({ scale: Math.min(2, 1100 / viewport.width) });
        element.width = Math.ceil(scaled.width);
        element.height = Math.ceil(scaled.height);
        const context = element.getContext('2d');
        if (!context)
          throw new Error(t('无法创建 PDF 预览画布。', 'Could not create the PDF preview canvas.'));
        task = page.render({ canvasContext: context, canvas: element, viewport: scaled });
        await task.promise;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber]);

  async function preview() {
    const request = ++generation.current;
    setGenerating(true);
    setError('');
    setNotice('');
    try {
      const article = await prepareArticle();
      if (request !== generation.current) return;
      const collected = await collectExportBlocks(article);
      const data = await buildPdf(collected, title, { ...value, language });
      if (request !== generation.current) return;
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      // PDF.js transfers its input buffer to the worker. Keep the export bytes intact.
      const result = await pdfjs.getDocument({ data: data.slice() }).promise;
      if (request !== generation.current) {
        await result.loadingTask.destroy();
        return;
      }
      if (activePdf.current) await activePdf.current.loadingTask.destroy();
      if (request !== generation.current) {
        await result.loadingTask.destroy();
        return;
      }
      activePdf.current = result;
      setPreviewResult({ key: previewKey, bytes: data, pdf: result });
      setPageNumber(1);
    } catch (reason) {
      if (request === generation.current)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      if (request === generation.current) setGenerating(false);
    }
  }

  async function saveForPrint() {
    if (!bytes) return;
    const request = generation.current;
    setSaving(true);
    try {
      if ((await saveExportBytes('pdf', bytes, title)) && request === generation.current)
        setNotice(
          t(
            'PDF 已保存。使用系统 PDF 阅读器打开后，按 Ctrl+P 打印。',
            'PDF saved. Open it in your system PDF reader, then press Ctrl+P to print.',
          ),
        );
    } catch (reason) {
      if (request === generation.current)
        setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="export-options-panel">
      <div className="export-layout-options">
        <label>
          {t('排版模板', 'Layout template')}
          <select
            aria-label={t('排版模板', 'Layout template')}
            value={value.template || 'standard'}
            onChange={(event) =>
              update({ template: event.target.value as ExportOptions['template'] })
            }
          >
            <option value="standard">{t('标准文档', 'Standard document')}</option>
            <option value="academic">{t('学术阅读', 'Academic reading')}</option>
            <option value="compact">{t('紧凑笔记', 'Compact notes')}</option>
          </select>
        </label>
        <label className="export-checkbox">
          <input
            type="checkbox"
            aria-label={t('包含文档目录', 'Include a table of contents')}
            checked={Boolean(value.toc)}
            onChange={(event) => update({ toc: event.target.checked })}
          />
          {t('包含文档目录', 'Include a table of contents')}
        </label>
        {format === 'html' ? (
          <label>
            {t('外观', 'Appearance')}
            <select
              aria-label={t('外观', 'Appearance')}
              value={value.theme || 'light'}
              onChange={(event) => update({ theme: event.target.value })}
            >
              <option value="light">{t('浅色', 'Light')}</option>
              <option value="dark">{t('深色', 'Dark')}</option>
            </select>
          </label>
        ) : (
          <>
            <label>
              {t('纸张', 'Paper size')}
              <select
                aria-label={t('纸张', 'Paper size')}
                value={value.paper || 'A4'}
                onChange={(event) =>
                  update({ paper: event.target.value as ExportOptions['paper'] })
                }
              >
                <option value="A4">A4</option>
                <option value="LETTER">Letter</option>
                <option value="A5">A5</option>
              </select>
            </label>
            <fieldset className="export-margins">
              <legend>{t('页边距（毫米）', 'Margins (mm)')}</legend>
              {(['top', 'right', 'bottom', 'left'] as const).map((side, index) => (
                <label key={side}>
                  {t(['上', '右', '下', '左'][index], ['Top', 'Right', 'Bottom', 'Left'][index])}
                  <input
                    type="number"
                    aria-label={t(
                      ['上', '右', '下', '左'][index],
                      ['Top', 'Right', 'Bottom', 'Left'][index],
                    )}
                    min="12"
                    max="40"
                    step="1"
                    value={
                      Number.isFinite(margins[side]) ? Math.round(margins[side] * 10) / 10 : ''
                    }
                    onChange={(event) =>
                      update({ margins: { ...margins, [side]: event.target.valueAsNumber } })
                    }
                  />
                </label>
              ))}
            </fieldset>
            <label>
              {t('页眉', 'Header')}
              <input
                type="text"
                maxLength={40}
                aria-label={t('页眉', 'Header')}
                value={value.header || ''}
                placeholder={t('可留空', 'Optional')}
                onChange={(event) => update({ header: event.target.value })}
              />
            </label>
            <label>
              {t('页脚', 'Footer')}
              <input
                type="text"
                maxLength={40}
                aria-label={t('页脚', 'Footer')}
                value={value.footer || ''}
                placeholder={t('可留空', 'Optional')}
                onChange={(event) => update({ footer: event.target.value })}
              />
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                aria-label={t('显示页码', 'Show page numbers')}
                checked={value.pageNumbers !== false}
                onChange={(event) => update({ pageNumbers: event.target.checked })}
              />
              {t('显示页码', 'Show page numbers')}
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                aria-label={t('添加封面', 'Add a cover page')}
                checked={Boolean(value.cover)}
                onChange={(event) => update({ cover: event.target.checked })}
              />
              {t('添加封面', 'Add a cover page')}
            </label>
            {value.cover && (
              <label>
                {t('封面副标题', 'Cover subtitle')}
                <input
                  type="text"
                  maxLength={200}
                  aria-label={t('封面副标题', 'Cover subtitle')}
                  value={value.coverSubtitle || ''}
                  onChange={(event) => update({ coverSubtitle: event.target.value })}
                />
              </label>
            )}
          </>
        )}
        <p className="export-detail">
          {t(
            '本地图片、公式与图表会嵌入文件；无法加载的内容会提示处理。',
            'Local images, math, and diagrams are embedded. Content that cannot be loaded is reported.',
          )}
        </p>
        {format === 'docx' && (
          <p className="export-detail">
            {t(
              '预览为同一内容生成的 PDF。Word 分页可能不同；DOCX 目录提供标题链接。',
              'The preview is a PDF of the same content. Word pagination may differ; the DOCX contents list links to headings.',
            )}
          </p>
        )}
      </div>
      {format !== 'html' && (
        <section className="export-preview" aria-label={t('PDF 排版预览', 'PDF layout preview')}>
          <div className="export-preview-actions">
            <button
              type="button"
              onClick={() => void preview()}
              disabled={busy || generating || saving}
            >
              {generating ? (
                <LoaderCircle size={15} className="export-spinner" />
              ) : (
                <Eye size={15} />
              )}
              {generating
                ? t('生成中…', 'Generating…')
                : pdf
                  ? t('重新生成预览', 'Refresh preview')
                  : t('生成 PDF 预览', 'Generate PDF preview')}
            </button>
            {bytes && (
              <button
                type="button"
                onClick={() => void saveForPrint()}
                disabled={saving || generating || busy}
              >
                <FileDown size={15} />
                {saving ? t('保存中…', 'Saving…') : t('保存 PDF 以打印', 'Save PDF for printing')}
              </button>
            )}
          </div>
          {error && (
            <p className="export-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="export-detail" role="status">
              {notice}
            </p>
          )}
          {pdf ? (
            <>
              <div className="export-page-navigation">
                <button
                  type="button"
                  aria-label={t('上一页', 'Previous page')}
                  disabled={pageNumber <= 1 || rendering}
                  onClick={() => setPageNumber((page) => page - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <span aria-live="polite">
                  {pageNumber} / {pdf.numPages}
                </span>
                <button
                  type="button"
                  aria-label={t('下一页', 'Next page')}
                  disabled={pageNumber >= pdf.numPages || rendering}
                  onClick={() => setPageNumber((page) => page + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
              <div className="export-preview-sheet" aria-busy={rendering}>
                <canvas
                  ref={canvas}
                  aria-label={t(`PDF 第 ${pageNumber} 页`, `PDF page ${pageNumber}`)}
                />
              </div>
            </>
          ) : (
            <div className="export-preview-empty">
              {t(
                '生成预览后可查看真实 PDF 的每一页。修改排版后，需要重新生成。',
                'Generate a preview to view every page of the actual PDF. Regenerate after changing the layout.',
              )}
            </div>
          )}
          <p className="export-detail">
            {t(
              '打印：保存 PDF，再用系统 PDF 阅读器打开并打印。',
              'To print, save the PDF and open it in your system PDF reader.',
            )}
          </p>
        </section>
      )}
    </div>
  );
}
