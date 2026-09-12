export { default as Editor, releaseEditor, updateStoredEditor } from './Editor';
export { undo, redo, selectAll } from '@codemirror/commands';
export { openSearchPanel } from '@codemirror/search';
export { applyFormatting, insertMarkdownTransaction, readTableAtSelection } from './formatting';
import { EditorView } from '@codemirror/view';
export const scrollIntoView = EditorView.scrollIntoView;
