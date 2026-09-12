import { forwardRef, Suspense, useImperativeHandle, useRef } from 'react';
import { X } from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import type { Document, Mode, Settings } from '../lib/types';
import type { InsertKind } from './InsertDialog';
import { t, useI18n } from '../lib/i18n';
import Reader, { type ReaderHandle } from '../Reader';
import Editor, {
  applyFormatting,
  undo,
  redo,
  selectAll,
  openSearchPanel,
} from '../editor/lazyEditor';
import type { EditingAction } from './EditingMenu';
import { markdownProfileOptions } from '../lib/markdownProfile';
export type CompareHandle = {
  edit: (run: (view: EditorView) => void) => void;
  view: EditorView | null;
  action: (action: EditingAction) => boolean;
  mode: Mode;
};
type Props = {
  document: Document;
  documents: Document[];
  mode: Mode;
  settings: Settings;
  revision: number;
  onInsert: (kind: InsertKind) => void;
  onDocumentClose: () => void;
  onSelect: (id: string) => void;
  onMode: (mode: Mode) => void;
  onClose: () => void;
  onCompare?: () => void;
  onChange: (text: string) => void;
  onSave: (asNew?: boolean) => void;
  onComposition: (active: boolean) => void;
  onImage: (file: File, view: EditorView) => void;
  onPasteError?: (message: string) => void;
  onLink: (href: string) => void;
  onFocused: () => void;
  linked: boolean;
  onLinked: (value: boolean) => void;
};
export default forwardRef<CompareHandle, Props>(function ComparePane(props, ref) {
  useI18n();
  const editor = useRef<EditorView | null>(null);
  const reader = useRef<ReaderHandle | null>(null);
  const pending = useRef<((view: EditorView) => void) | null>(null);
  function edit(run: (view: EditorView) => void) {
    if (editor.current && props.mode !== 'read') run(editor.current);
    else {
      pending.current = run;
      props.onMode('live');
    }
  }
  useImperativeHandle(ref, () => ({
    edit,
    get view() {
      return editor.current;
    },
    mode: props.mode,
    action(action) {
      if (action.startsWith('format:')) {
        edit((view) =>
          applyFormatting(view, action.slice(7) as Parameters<typeof applyFormatting>[1]),
        );
        return true;
      }
      if (action.startsWith('insert:')) {
        props.onInsert(action.slice(7) as InsertKind);
        return true;
      }
      switch (action) {
        case 'app:close':
          props.onDocumentClose();
          return true;
        case 'app:save':
          props.onSave();
          return true;
        case 'app:saveAs':
          props.onSave(true);
          return true;
        case 'app:undo':
          edit((view) => undo(view));
          return true;
        case 'app:redo':
          edit((view) => redo(view));
          return true;
        case 'app:selectAll':
          if (props.mode === 'read') reader.current?.selectAll();
          else if (editor.current) selectAll(editor.current);
          return true;
        case 'app:find':
          if (props.mode === 'read') reader.current?.openSearch();
          else if (editor.current) openSearchPanel(editor.current);
          return true;
        case 'app:replace':
          edit((view) => openSearchPanel(view));
          return true;
        case 'view:live':
          props.onMode('live');
          return true;
        case 'view:source':
          props.onMode('source');
          return true;
        case 'view:read':
          props.onMode('read');
          return true;
        case 'view:bookmark':
          reader.current?.toggleBookmark();
          return true;
        case 'view:bookmarks':
          reader.current?.openBookmarks();
          return true;
        default:
          return false;
      }
    },
  }));
  return (
    <section
      className="compare-pane"
      aria-label={t('右侧对照文档', 'Right comparison document')}
      onFocusCapture={props.onFocused}
      onPointerDownCapture={props.onFocused}
    >
      <div className="compare-toolbar">
        <select
          aria-label={t('对照文档')}
          value={props.document.id}
          onChange={(event) => props.onSelect(event.target.value)}
        >
          {props.documents.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.name}
            </option>
          ))}
        </select>
        <button aria-label={t('关闭并排对照')} onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="compare-toolbar">
        {props.onCompare && (
          <button onClick={props.onCompare}>{t('文字差异', 'Text differences')}</button>
        )}
        {(['read', 'live', 'source'] as const).map((mode) => (
          <button key={mode} aria-pressed={props.mode === mode} onClick={() => props.onMode(mode)}>
            {mode === 'read'
              ? t('阅读', 'Read')
              : mode === 'live'
                ? t('编辑', 'Edit')
                : t('源码', 'Source')}
          </button>
        ))}
        <button onClick={() => props.onSave()} disabled={props.mode === 'read'}>
          {t('保存', 'Save')}
        </button>
        <label>
          <input
            type="checkbox"
            checked={props.linked}
            onChange={(event) => props.onLinked(event.target.checked)}
          />
          {t('同步滚动', 'Sync scroll')}
        </label>
      </div>
      <div className="compare-content" data-custom-document-theme="">
        {props.mode === 'read' ? (
          <Reader
            ref={reader}
            documentKey={`compare:${props.document.id}`}
            content={props.document.content}
            path={props.document.path}
            theme={props.settings.theme}
            revision={props.revision}
            parseOptions={markdownProfileOptions(props.settings)}
            onLink={props.onLink}
          />
        ) : (
          <Suspense fallback={<p>{t('正在打开编辑器…', 'Opening editor…')}</p>}>
            <Editor
              id={`compare:${props.document.id}`}
              content={props.document.content}
              path={props.document.path}
              mode={props.mode}
              onChange={props.onChange}
              onReady={(view) => {
                editor.current = view;
                if (view && pending.current) {
                  const action = pending.current;
                  pending.current = null;
                  action(view);
                }
              }}
              onEditTable={({ from }) => {
                editor.current?.dispatch({ selection: { anchor: from } });
                props.onInsert('table');
              }}
              onSelection={() => {}}
              onComposition={props.onComposition}
              onPasteError={props.onPasteError}
              onImage={(file) => {
                if (editor.current) props.onImage(file, editor.current);
              }}
              onLink={props.onLink}
            />
          </Suspense>
        )}
      </div>
      <div className="compare-status" role="status">
        {props.document.status === 'conflict' || props.document.status === 'error'
          ? props.document.error ||
            t('保存冲突，请检查左侧提示', 'Save conflict; review the document alert')
          : props.document.content === props.document.saved
            ? t('已保存', 'Saved')
            : t('未保存', 'Unsaved')}
      </div>
    </section>
  );
});
