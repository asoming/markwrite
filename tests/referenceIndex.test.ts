import { describe, expect, it, vi } from 'vitest';
import { ReferenceIndex } from '../src/lib/referenceIndex';
import { documentReferences } from '../src/lib/workspace';
describe('background reference index', () => {
  it('reuses parsed documents across navigation and parses only changed buffers', () => {
    const parse = vi.fn(documentReferences),
      index = new ReferenceIndex(parse);
    const disk = [
      { path: '/notes/a.md', content: '[[b]]\n\n#工作' },
      { path: '/notes/b.md', content: '`[[a]] #例子`\n\n#计划' },
      { path: '/notes/c.md', content: '[b](b.md#标题)\n\n#工作' },
    ];
    index.setDisk(disk);
    expect(index.query([], '/notes/b.md').incoming.map((d) => d.path)).toEqual([
      '/notes/a.md',
      '/notes/c.md',
    ]);
    expect(parse).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 20; i++) index.query([], i % 2 ? '/notes/a.md' : '/notes/b.md');
    expect(parse).toHaveBeenCalledTimes(3);
    const result = index.query([{ ...disk[0], content: '[[c]]\n\n#新标签' }], '/notes/b.md');
    expect(parse).toHaveBeenCalledTimes(4);
    expect(result.incoming.map((d) => d.path)).toEqual(['/notes/c.md']);
    expect(result.tags.map(([tag]) => tag)).toContain('新标签');
    expect(result.tags.map(([tag]) => tag)).not.toContain('例子');
    expect(result.incoming.every((d) => d.content === '')).toBe(true);
  });
  it('replaces stale disk snapshots and drops deleted files and closed buffers', () => {
    const index = new ReferenceIndex();
    index.setDisk([
      { path: '/a.md', content: '#旧' },
      { path: '/b.md', content: '[[a]]' },
    ]);
    expect(index.query([], '/a.md').incoming).toHaveLength(1);
    index.setDisk([{ path: '/a.md', content: '#新' }]);
    const result = index.query([], '/a.md');
    expect(result.incoming).toHaveLength(0);
    expect(result.tags.map(([tag]) => tag)).toEqual(['新']);
  });
  it('keeps ambiguous wiki targets explicit and canonicalizes live Windows paths', () => {
    const index = new ReferenceIndex();
    index.setDisk([
      { path: 'C:/notes/a.md', content: '[[b]]' },
      { path: 'C:/notes/b.md', content: '' },
      { path: 'C:/notes/sub/b.md', content: '' },
    ]);
    const result = index.query(
      [{ path: 'c:\\notes\\a.md', content: '[[b]]\n\n#未保存' }],
      'C:/notes/a.md',
    );
    expect(result.documents).toBe(3);
    expect(result.graph.ambiguous).toHaveLength(1);
    expect(result.graph.neighbors).toHaveLength(0);
  });
  it('handles a large workspace without reparsing on a panel switch', () => {
    const parse = vi.fn(documentReferences),
      index = new ReferenceIndex(parse);
    const documents = Array.from({ length: 1000 }, (_, i) => ({
      path: `/notes/${i}.md`,
      content: `[[${(i + 1) % 1000}]]\n\n#分类${i % 10}\n\n` + '写作内容。'.repeat(50),
    }));
    index.setDisk(documents);
    index.query([], '/notes/1.md');
    expect(index.query([], '/notes/2.md').incoming[0].path).toBe('/notes/1.md');
    expect(parse).toHaveBeenCalledTimes(1000);
  });
});
it('uses the first live buffer when duplicate aliases of the same path are open', () => {
  const index = new ReferenceIndex();
  index.setDisk([{ path: 'C:/notes/a.md', content: '#磁盘' }]);
  const result = index.query(
    [
      { path: 'C:/notes/a.md', content: '#最新' },
      { path: 'c:\\notes\\a.md', content: '#旧副本' },
    ],
    'C:/notes/a.md',
  );
  expect(result.documents).toBe(1);
  expect(result.tags.map(([name]) => name)).toEqual(['最新']);
});
