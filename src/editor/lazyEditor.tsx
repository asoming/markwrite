import { lazy } from 'react';
import type * as Runtime from './editorRuntime';

let runtime: typeof Runtime | undefined;
const load = () => import('./editorRuntime').then((module) => (runtime = module));
const Editor = lazy(async () => ({ default: (await load()).Editor }));
export default Editor;

// These commands run only after onReady, so reading never downloads CodeMirror.
function loaded() {
  if (!runtime) throw new Error('The editor is still loading');
  return runtime;
}
export const releaseEditor: typeof Runtime.releaseEditor = (id) => runtime?.releaseEditor(id);
export const updateStoredEditor: typeof Runtime.updateStoredEditor = (id, text) =>
  runtime?.updateStoredEditor(id, text);
export const undo: typeof Runtime.undo = (...args) => loaded().undo(...args);
export const redo: typeof Runtime.redo = (...args) => loaded().redo(...args);
export const selectAll: typeof Runtime.selectAll = (...args) => loaded().selectAll(...args);
export const openSearchPanel: typeof Runtime.openSearchPanel = (...args) =>
  loaded().openSearchPanel(...args);
export const scrollIntoView: typeof Runtime.scrollIntoView = (...args) =>
  loaded().scrollIntoView(...args);
export const applyFormatting: typeof Runtime.applyFormatting = (...args) =>
  loaded().applyFormatting(...args);
export const insertMarkdownTransaction: typeof Runtime.insertMarkdownTransaction = (...args) =>
  loaded().insertMarkdownTransaction(...args);
export const readTableAtSelection: typeof Runtime.readTableAtSelection = (...args) =>
  loaded().readTableAtSelection(...args);
