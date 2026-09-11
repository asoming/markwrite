import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  placeholder,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { documentPath, liveMode, livePreview, compositionState } from './livePreview';
import type { Mode } from '../lib/types';

const sessions = new Map<string, { state: EditorState; scroll: number }>();
export function releaseEditor(id: string) {
  sessions.delete(id);
}
const modeCompartment = new Compartment();
const pathCompartment = new Compartment();
export type EditorHandle = EditorView;
export default function Editor({
  id,
  content,
  path,
  mode,
  onChange,
  onReady,
  onSelection,
  onImage,
  onComposition,
}: {
  id: string;
  content: string;
  path?: string;
  mode: Mode;
  onChange: (text: string) => void;
  onReady: (view: EditorView | null) => void;
  onSelection: (line: number, column: number) => void;
  onImage: (file: File) => void;
  onComposition: (active: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onReady, onSelection, onImage, onComposition });
  callbacks.current = { onChange, onReady, onSelection, onImage, onComposition };
  useEffect(() => {
    if (!host.current) return;
    const initial = sessions.get(id);
    const state =
      initial?.state ||
      EditorState.create({
        doc: content,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(defaultHighlightStyle),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          placeholder('从一个标题，或一个想法开始…'),
          modeCompartment.of(liveMode.of(mode === 'live')),
          pathCompartment.of(documentPath.of(path || '')),
          livePreview,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器', spellcheck: 'false' }),
          EditorView.domEventHandlers({
            compositionstart: () => {
              callbacks.current.onComposition(true);
              queueMicrotask(() => view.current?.dispatch({ effects: compositionState.of(true) }));
            },
            compositionend: () => {
              callbacks.current.onComposition(false);
              setTimeout(() => view.current?.dispatch({ effects: compositionState.of(false) }), 0);
            },
            paste: (event) => {
              const file = [...(event.clipboardData?.files || [])].find((f) =>
                f.type.startsWith('image/'),
              );
              if (file) {
                event.preventDefault();
                callbacks.current.onImage(file);
                return true;
              }
              return false;
            },
            drop: (event) => {
              const file = [...(event.dataTransfer?.files || [])].find((f) =>
                f.type.startsWith('image/'),
              );
              if (file) {
                event.preventDefault();
                callbacks.current.onImage(file);
                return true;
              }
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              callbacks.current.onSelection(line.number, head - line.from + 1);
            }
          }),
        ],
      });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    editor.dispatch({
      effects: [
        modeCompartment.reconfigure(liveMode.of(mode === 'live')),
        pathCompartment.reconfigure(documentPath.of(path || '')),
      ],
    });
    if (initial) editor.scrollDOM.scrollTop = initial.scroll;
    callbacks.current.onReady(editor);
    return () => {
      sessions.set(id, { state: editor.state, scroll: editor.scrollDOM.scrollTop });
      callbacks.current.onReady(null);
      editor.destroy();
      view.current = null;
    };
  }, [id]); // One document session owns its state and undo stack, independently of React renders.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.doc.toString() !== content)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: content },
        annotations: Transaction.addToHistory.of(false),
      });
  }, [content, id]);
  useEffect(() => {
    view.current?.dispatch({ effects: modeCompartment.reconfigure(liveMode.of(mode === 'live')) });
  }, [mode]);
  useEffect(() => {
    view.current?.dispatch({ effects: pathCompartment.reconfigure(documentPath.of(path || '')) });
  }, [path]);
  return (
    <div
      className={`editor-host ${mode === 'read' ? 'editor-hidden' : ''} ${mode === 'source' ? 'source-mode' : ''}`}
      ref={host}
    />
  );
}
