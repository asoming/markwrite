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
import {
  documentPath,
  liveMode,
  livePreview,
  compositionState,
  syntaxChanged,
} from './livePreview';
import type { Mode } from '../lib/types';
import {
  applyFormatting,
  clipboardMarkdown,
  insertMarkdownTransaction,
  type FormatAction,
} from './formatting';

const sessions = new Map<string, { state: EditorState; scroll: number }>();
export function releaseEditor(id: string) {
  sessions.delete(id);
}
const modeCompartment = new Compartment();
const pathCompartment = new Compartment();
const parsingCompartment = new Compartment();
const syntaxExtensions = () => [
  syntaxHighlighting(defaultHighlightStyle),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
];
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
  onMarkdownFiles,
  onEditTable,
  onLink,
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
  onMarkdownFiles?: (files: File[]) => void;
  onEditTable?: (range: { from: number; to: number }) => void;
  onLink?: (href: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({
    onChange,
    onReady,
    onSelection,
    onImage,
    onComposition,
    onMarkdownFiles,
    onEditTable,
    onLink,
  });
  callbacks.current = {
    onChange,
    onReady,
    onSelection,
    onImage,
    onComposition,
    onMarkdownFiles,
    onEditTable,
    onLink,
  };
  useEffect(() => {
    if (!host.current) return;
    const initial = sessions.get(id);
    let plainPaste = false;
    let largeDocument = content.length > 1_000_000;
    const formatKey = (key: string, action: FormatAction) => ({
      key,
      run: (editor: EditorView) => applyFormatting(editor, action),
    });
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
          parsingCompartment.of(largeDocument ? [] : syntaxExtensions()),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([
            formatKey('Mod-b', 'bold'),
            formatKey('Mod-i', 'italic'),
            formatKey('Mod-Shift-x', 'strike'),
            formatKey('Mod-e', 'inlineCode'),
            formatKey('Mod-Alt-1', 'heading1'),
            formatKey('Mod-Alt-2', 'heading2'),
            formatKey('Mod-Alt-3', 'heading3'),
            formatKey('Alt-ArrowUp', 'moveUp'),
            formatKey('Alt-ArrowDown', 'moveDown'),
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
            keydown: (event) => {
              plainPaste =
                (event.ctrlKey || event.metaKey) &&
                event.shiftKey &&
                event.key.toLowerCase() === 'v';
              return false;
            },
            compositionstart: () => {
              callbacks.current.onComposition(true);
              queueMicrotask(() => view.current?.dispatch({ effects: compositionState.of(true) }));
            },
            compositionend: () => {
              callbacks.current.onComposition(false);
              setTimeout(() => view.current?.dispatch({ effects: compositionState.of(false) }), 0);
            },
            paste: (event, editor) => {
              const pastePlain = plainPaste;
              plainPaste = false;
              if (pastePlain) return false;
              const file = [...(event.clipboardData?.files || [])].find((f) =>
                f.type.startsWith('image/'),
              );
              if (file) {
                event.preventDefault();
                callbacks.current.onImage(file);
                return true;
              }
              const html = event.clipboardData?.getData('text/html');
              if (html && editor.state.facet(liveMode) && !editor.composing) {
                const text = clipboardMarkdown(html);
                if (text) {
                  event.preventDefault();
                  editor.dispatch(insertMarkdownTransaction(editor.state, text));
                  return true;
                }
              }
              return false;
            },
            drop: (event) => {
              const documents = [...(event.dataTransfer?.files || [])].filter((file) =>
                /\.(md|markdown)$/i.test(file.name),
              );
              if (documents.length && callbacks.current.onMarkdownFiles) {
                event.preventDefault();
                callbacks.current.onMarkdownFiles(documents);
                return true;
              }
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
            if (update.docChanged && update.state.doc.length > 1_000_000 !== largeDocument) {
              largeDocument = update.state.doc.length > 1_000_000;
              queueMicrotask(() =>
                view.current?.dispatch({
                  effects: parsingCompartment.reconfigure(largeDocument ? [] : syntaxExtensions()),
                }),
              );
            }
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              callbacks.current.onSelection(line.number, head - line.from + 1);
            }
          }),
        ],
      });
    const editor = new EditorView({ state, parent: host.current });
    const editTable = (event: Event) =>
      callbacks.current.onEditTable?.((event as CustomEvent<{ from: number; to: number }>).detail);
    editor.dom.addEventListener('markwrite:edit-table', editTable);
    const followLink = (event: Event) =>
      callbacks.current.onLink?.((event as CustomEvent<string>).detail);
    editor.dom.addEventListener('markwrite:follow-link', followLink);
    const refreshSyntax = () => editor.dispatch({ effects: syntaxChanged.of(null) });
    window.addEventListener('markwrite-syntax-configured', refreshSyntax);
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
      editor.dom.removeEventListener('markwrite:edit-table', editTable);
      editor.dom.removeEventListener('markwrite:follow-link', followLink);
      window.removeEventListener('markwrite-syntax-configured', refreshSyntax);
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
