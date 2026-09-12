import { t, useI18n } from '../lib/i18n';
import { nativeClipboardImage, transferredImage, htmlClipboardImage } from '../lib/clipboardImage';
import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  placeholder,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  searchPanelOpen,
  closeSearchPanel,
  openSearchPanel,
} from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  HighlightStyle,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
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

const synchronizedEdit = Annotation.define<boolean>();
const sharedViews = new Map<string, Set<EditorView>>();
// Preserve unchanged ranges so peer cursors and undo entries map through an edit.
function textChange(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}
const sessions = new Map<string, { state: EditorState; scroll: number }>();
export function releaseEditor(id: string) {
  sessions.delete(id);
}
export function updateStoredEditor(id: string, content: string) {
  const session = sessions.get(id);
  if (session && session.state.doc.toString() !== content) {
    session.state = session.state.update({
      changes: { from: 0, to: session.state.doc.length, insert: content },
      userEvent: 'input.references',
    }).state;
  }
}
const modeCompartment = new Compartment();
const pathCompartment = new Compartment();
const parsingCompartment = new Compartment();
const interfaceCompartment = new Compartment();
function interfaceExtensions(language: 'zh-CN' | 'en') {
  return [
    placeholder(t('从一个标题，或一个想法开始…')),
    EditorView.contentAttributes.of({ 'aria-label': t('Markdown 编辑器'), spellcheck: 'false' }),
    EditorState.phrases.of(
      language === 'en'
        ? {}
        : {
            Find: '查找',
            Replace: '替换',
            next: '下一处',
            previous: '上一处',
            all: '全选匹配',
            'match case': '区分大小写',
            regexp: '正则表达式',
            'by word': '完整单词',
            replace: '替换',
            'replace all': '全部替换',
            close: '关闭',
            'Go to line': '跳转到行',
            go: '跳转',
            'current match': '当前匹配',
            'on line': '所在行',
            'replaced $ matches': '已替换 $ 处匹配',
            'replaced match on line $': '已替换第 $ 行匹配',
          },
    ),
  ];
}
const syntaxExtensions = () => [
  syntaxHighlighting(defaultHighlightStyle),
  syntaxHighlighting(HighlightStyle.define([{ tag: tags.heading, class: 'cm-syntax-heading' }])),
  markdown({ base: markdownLanguage, codeLanguages: languages }),
];
export type EditorHandle = EditorView;
export default function Editor({
  id,
  sharedDocumentId,
  content,
  path,
  mode,
  onChange,
  onReady,
  onSelection,
  onImage,
  onPasteError,
  onComposition,
  onMarkdownFiles,
  onEditTable,
  onLink,
}: {
  id: string;
  sharedDocumentId?: string;
  content: string;
  path?: string;
  mode: Mode;
  onChange: (text: string) => void;
  onReady: (view: EditorView | null) => void;
  onSelection: (line: number, column: number) => void;
  onImage: (file: File) => void;
  onPasteError?: (message: string) => void;
  onComposition: (active: boolean) => void;
  onMarkdownFiles?: (files: File[]) => void;
  onEditTable?: (range: { from: number; to: number }) => void;
  onLink?: (href: string) => void;
}) {
  const { language } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const localEchoes = useRef({ id, sequence: 0, bytes: 0, texts: new Map<string, number>() });
  const synchronizedContent = useRef<{ id: string; content: string } | undefined>(undefined);
  const callbacks = useRef({
    onChange,
    onReady,
    onSelection,
    onImage,
    onPasteError,
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
    onPasteError,
    onComposition,
    onMarkdownFiles,
    onEditTable,
    onLink,
  };
  useEffect(() => {
    if (!host.current) return;
    const initial = sessions.get(id);
    if (localEchoes.current.id !== id)
      localEchoes.current = { id, sequence: 0, bytes: 0, texts: new Map() };
    let plainPaste = false;
    let pasteEpoch = 0;
    let pasteTimer: ReturnType<typeof setTimeout> | undefined;
    function pasteNative(editor: EditorView, epoch: number) {
      const original = editor.state.doc;
      const selection = editor.state.selection;
      void nativeClipboardImage()
        .then((image) => {
          if (epoch !== pasteEpoch) return;
          if (!image) {
            callbacks.current.onPasteError?.(
              t(
                '剪贴板中没有可粘贴的图片，请重新复制图片或使用插入图片。',
                'No image is available. Copy the image again or use Insert image.',
              ),
            );
            return;
          }
          if (
            view.current !== editor ||
            editor.state.doc !== original ||
            !editor.state.selection.eq(selection)
          ) {
            callbacks.current.onPasteError?.(
              t(
                '粘贴位置已改变，请重新粘贴图片。',
                'The paste location changed. Please paste the image again.',
              ),
            );
            return;
          }
          callbacks.current.onImage(image);
        })
        .catch((error) => {
          if (epoch === pasteEpoch) callbacks.current.onPasteError?.(String(error));
        });
    }

    let compositionEpoch = 0;
    let compositionTimer: ReturnType<typeof setTimeout> | undefined;
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
          interfaceCompartment.of(interfaceExtensions(language)),
          modeCompartment.of(liveMode.of(mode === 'live')),
          pathCompartment.of(documentPath.of(path || '')),
          livePreview,
          EditorView.domEventHandlers({
            keydown: (event, editor) => {
              plainPaste =
                (event.ctrlKey || event.metaKey) &&
                event.shiftKey &&
                event.key.toLowerCase() === 'v';
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 'v' &&
                !event.shiftKey &&
                !event.altKey &&
                !event.isComposing
              ) {
                const epoch = ++pasteEpoch;
                clearTimeout(pasteTimer);
                // Some WebKit clipboard formats never produce a DOM paste event.
                pasteTimer = setTimeout(() => {
                  if (epoch === pasteEpoch) pasteNative(editor, epoch);
                }, 120);
              }
              return false;
            },
            compositionstart: () => {
              clearTimeout(compositionTimer);
              const epoch = ++compositionEpoch;
              callbacks.current.onComposition(true);
              queueMicrotask(() => {
                if (epoch === compositionEpoch && view.current === editor)
                  editor.dispatch({ effects: compositionState.of(true) });
              });
            },
            compositionend: () => {
              const epoch = ++compositionEpoch;
              // WebKit can deliver the final DOM change after compositionend.
              // CodeMirror clears its composition view on a 50ms timer; rebuilding
              // rich decorations earlier can erase the accepted candidate.
              compositionTimer = setTimeout(() => {
                if (
                  epoch !== compositionEpoch ||
                  view.current !== editor ||
                  editor.compositionStarted
                )
                  return;
                editor.dispatch({ effects: compositionState.of(false) });
                callbacks.current.onComposition(false);
              }, 75);
            },
            paste: (event, editor) => {
              clearTimeout(pasteTimer);
              pasteEpoch++;
              const pastePlain = plainPaste;
              plainPaste = false;
              if (pastePlain) return false;
              const file = transferredImage(event.clipboardData);
              if (file) {
                event.preventDefault();
                callbacks.current.onImage(file);
                return true;
              }
              const html = event.clipboardData?.getData('text/html');
              const htmlImage = htmlClipboardImage(html || '');
              if (htmlImage) {
                event.preventDefault();
                callbacks.current.onImage(htmlImage);
                return true;
              }
              if (
                html &&
                (editor.state.facet(liveMode) || /<img\b/i.test(html)) &&
                !editor.composing
              ) {
                const text = clipboardMarkdown(html);
                if (text) {
                  event.preventDefault();
                  editor.dispatch(insertMarkdownTransaction(editor.state, text));
                  return true;
                }
              }
              if (
                !event.clipboardData?.getData('text/plain') ||
                /^file:\/\//m.test(event.clipboardData?.getData('text/uri-list') || '')
              ) {
                event.preventDefault();
                pasteNative(editor, pasteEpoch);
                return true;
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
            if (update.docChanged) {
              const content = update.state.doc.toString();
              const echoes = localEchoes.current;
              if (!echoes.texts.has(content)) echoes.bytes += content.length * 2;
              echoes.texts.set(content, ++echoes.sequence);
              // Usually only one or two React acknowledgements are outstanding.
              // Bound retained snapshots for embedding hosts that never acknowledge edits.
              const budget = Math.max(8 * 1024 * 1024, content.length * 4);
              while (echoes.bytes > budget && echoes.texts.size > 2) {
                const oldest = echoes.texts.keys().next().value!;
                echoes.bytes -= oldest.length * 2;
                echoes.texts.delete(oldest);
              }
              if (
                !update.transactions.some((transaction) => transaction.annotation(synchronizedEdit))
              ) {
                // Update peers before React renders, including rapid alternating input.
                for (const peer of sharedViews.get(sharedDocumentId || id) || []) {
                  if (peer === update.view || peer.state.doc.eq(update.state.doc)) continue;
                  peer.dispatch({
                    changes: peer.state.doc.eq(update.startState.doc)
                      ? update.changes
                      : textChange(peer.state.doc.toString(), content),
                    annotations: [synchronizedEdit.of(true), Transaction.addToHistory.of(false)],
                  });
                }
                callbacks.current.onChange(content);
              }
            }
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
    const widgetComposition = (event: Event) =>
      callbacks.current.onComposition((event as CustomEvent<boolean>).detail);
    editor.dom.addEventListener('markwrite:widget-composition', widgetComposition);
    const refreshSyntax = () => editor.dispatch({ effects: syntaxChanged.of(null) });
    window.addEventListener('markwrite-syntax-configured', refreshSyntax);
    view.current = editor;
    editor.dispatch({
      effects: [
        compositionState.of(false),
        modeCompartment.reconfigure(liveMode.of(mode === 'live')),
        pathCompartment.reconfigure(documentPath.of(path || '')),
      ],
    });
    if (initial) editor.scrollDOM.scrollTop = initial.scroll;
    const sharedKey = sharedDocumentId || id;
    const peers = sharedViews.get(sharedKey) || new Set<EditorView>();
    peers.add(editor);
    sharedViews.set(sharedKey, peers);
    return () => {
      peers.delete(editor);
      if (!peers.size) sharedViews.delete(sharedKey);
      clearTimeout(compositionTimer);
      clearTimeout(pasteTimer);
      pasteEpoch++;
      compositionEpoch++;
      callbacks.current.onComposition(false);
      sessions.set(id, { state: editor.state, scroll: editor.scrollDOM.scrollTop });
      callbacks.current.onReady(null);
      editor.dom.removeEventListener('markwrite:edit-table', editTable);
      editor.dom.removeEventListener('markwrite:follow-link', followLink);
      editor.dom.removeEventListener('markwrite:widget-composition', widgetComposition);
      window.removeEventListener('markwrite-syntax-configured', refreshSyntax);
      editor.destroy();
      view.current = null;
    };
  }, [id, sharedDocumentId]); // One document session owns its state and undo stack, independently of React renders.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const panelOpen = searchPanelOpen(editor.state);
    const focused = document.activeElement;
    // The built-in search panel reads its phrases only when mounted. Its query state
    // remains in the editor while the panel is reopened with the new language.
    if (panelOpen) closeSearchPanel(editor);
    editor.dispatch({
      effects: [
        interfaceCompartment.reconfigure(interfaceExtensions(language)),
        syntaxChanged.of(null),
      ],
    });
    if (panelOpen) {
      openSearchPanel(editor);
      if (focused instanceof HTMLElement && focused.isConnected && !editor.dom.contains(focused))
        focused.focus();
    }
  }, [language, id]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // StrictMode may recreate this view after onReady dispatched a user command.
    // The same prop snapshot must not replace that newer editor transaction.
    const previous = synchronizedContent.current;
    if (previous?.id === id && previous.content === content) return;
    synchronizedContent.current = { id, content };
    const echoes = localEchoes.current;
    const acknowledged = echoes.id === id ? echoes.texts.get(content) : undefined;
    if (acknowledged !== undefined) {
      for (const [text, sequence] of echoes.texts)
        if (sequence <= acknowledged) {
          echoes.texts.delete(text);
          echoes.bytes -= text.length * 2;
        }
      // This is our own edit returning through React. A later native input may
      // already be present in CodeMirror; acknowledging must never roll it back.
      return;
    }
    echoes.texts.clear();
    echoes.bytes = 0;
    if (editor.state.doc.toString() !== content)
      editor.dispatch({
        changes: textChange(editor.state.doc.toString(), content),
        annotations: [synchronizedEdit.of(true), Transaction.addToHistory.of(false)],
      });
  }, [content, id]);
  useEffect(() => {
    view.current?.dispatch({ effects: modeCompartment.reconfigure(liveMode.of(mode === 'live')) });
  }, [mode]);
  useEffect(() => {
    view.current?.dispatch({ effects: pathCompartment.reconfigure(documentPath.of(path || '')) });
  }, [path]);
  useEffect(() => {
    // Pending formatting/undo commands may change the document synchronously here.
    // Announce readiness only after the latest buffer and configuration are applied.
    if (view.current) callbacks.current.onReady(view.current);
  }, [id]);
  return (
    <div
      className={`editor-host ${mode === 'read' ? 'editor-hidden' : ''} ${mode === 'source' ? 'source-mode' : ''}`}
      ref={host}
    />
  );
}
