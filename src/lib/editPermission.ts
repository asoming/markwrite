import type { Document, Mode } from './types';

/** Runtime intent is deliberately excluded from session recovery. */
export class EditPermission {
  private modes = new Map<string, Mode>();
  mode(id: string): Mode {
    return this.modes.get(id) || 'read';
  }
  select(id: string, mode: Mode) {
    this.modes.set(id, mode);
  }
  forget(id: string) {
    this.modes.delete(id);
  }
  canEdit(id: string) {
    return this.mode(id) !== 'read';
  }
  canAutosave(doc: Document) {
    return this.canEdit(doc.id) && !!doc.path && doc.status === 'dirty';
  }
}
