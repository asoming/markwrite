import { describe, expect, it } from 'vitest';
import { EditPermission } from '../src/lib/editPermission';
import { mergeRecoveredDocuments, parseSession } from '../src/lib/recovery';
import { portableReferences } from '../src/lib/referenceMaintenance';
import type { Document } from '../src/lib/types';
const doc = (id: string, content: string, saved = 'disk'): Document => ({
  id,
  name: 'sample.md',
  path: '/notes/sample.md',
  content,
  saved,
  status: content === saved ? 'clean' : 'dirty',
  bom: false,
  crlf: false,
  updated: 1,
  version: 'disk-v1',
});
describe('reading preserves the source until deliberate editing', () => {
  it('restored dirty and background documents cannot autosave', () => {
    const permission = new EditPermission();
    expect(permission.canAutosave(doc('recovered', 'draft'))).toBe(false);
    permission.select('other', 'live');
    expect(permission.canAutosave(doc('recovered', 'draft'))).toBe(false);
    permission.select('recovered', 'source');
    expect(permission.canAutosave(doc('recovered', 'draft'))).toBe(true);
    permission.select('recovered', 'read');
    expect(permission.canAutosave(doc('recovered', 'draft'))).toBe(false);
    expect(new EditPermission().canEdit('recovered')).toBe(false);
  });
  it('opening disk never replaces a recovered draft or duplicates a clean buffer', () => {
    const disk = doc('opened', 'disk'),
      old = doc('recovered', 'unsaved');
    const result = mergeRecoveredDocuments([disk], [old, doc('old-clean', 'disk')]);
    expect(result).toEqual([disk, old]);
    expect(old.content).toBe('unsaved');
    expect(mergeRecoveredDocuments([{ ...disk, version: 'new' }], [old])[1].status).toBe(
      'conflict',
    );
  });
  it('defaults to standard syntax without trusting truthy legacy values', () => {
    expect(
      parseSession(
        JSON.stringify({
          docs: [doc('old', 'draft')],
          settings: { markdownCompatibility: 'true' },
        }),
      )?.settings.markdownCompatibility,
    ).toBe(false);
  });
});
describe('portable document destinations', () => {
  it('collects Chinese, parent-relative, reference and HTML assets while ignoring examples', () => {
    const content =
      '# Article\n\n![图片](<../中文 目录/a.png>)\n\n[附件][ref]\n\n[ref]: files/report.pdf\n\n<img src="pics/a&amp;b.png">\n\n`![no](secret.png)`\n\n```md\n![no](example.png)\n```\n';
    const refs = portableReferences({ path: '/notes/sample.md', content });
    expect(refs.map((item) => item.source)).toEqual([
      '../中文 目录/a.png',
      'files/report.pdf',
      'pics/a&amp;b.png',
    ]);
    for (const item of refs) expect(content.slice(item.from, item.to)).toBe(item.source);
  });
  it('keeps UTF-16 offsets exact after emoji, escaped parentheses and nested labels', () => {
    const content =
      '🙂 ![x](img/a\\(b\\).png)\n\n[**附件**](<../a b.txt>)\n\n[remote](https://example.test/a.png)';
    const refs = portableReferences({ path: '/notes/sample.md', content });
    expect(refs).toHaveLength(3);
    for (const item of refs) expect(content.slice(item.from, item.to)).toBe(item.source);
  });
});
