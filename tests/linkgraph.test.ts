import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import LinkGraph, { deriveGraph } from '../src/components/LinkGraph';

describe('local document relationship graph', () => {
  it('resolves wiki aliases and relative Markdown links, retaining both directions', () => {
    const graph = deriveGraph(
      [
        { path: '/notes/甲.md', content: '[[乙#章节|另一个标题]]\n\n[乙](%E4%B9%99.md)' },
        { path: '/notes/乙.md', content: '[甲](./甲.md#段落)' },
      ],
      '/notes/甲.md',
    );
    expect(graph.neighbors).toMatchObject([
      { document: { path: '/notes/乙.md' }, incoming: 1, outgoing: 2 },
    ]);
    expect(graph.repeatedReferences).toBe(1);
    expect(graph.broken).toHaveLength(0);
  });
  it('does not invent edges for duplicate wiki titles and reports missing targets', () => {
    const graph = deriveGraph(
      [
        { path: '/notes/甲.md', content: '[[乙]] [[失踪文档]] [失踪](lost.md)' },
        { path: '/notes/乙.md', content: '' },
        { path: '/notes/sub/乙.md', content: '' },
      ],
      '/notes/甲.md',
    );
    expect(graph.neighbors).toHaveLength(0);
    expect(graph.ambiguous).toEqual([
      { target: '乙', candidates: ['/notes/乙.md', '/notes/sub/乙.md'] },
    ]);
    expect(graph.broken).toEqual(['失踪文档', 'lost.md']);
  });
  it('excludes code examples, remote links, attachments, and unrelated graph branches', () => {
    const graph = deriveGraph(
      [
        {
          path: '/notes/甲.md',
          content:
            '`[[乙]]`\n\n```md\n[[乙]]\n```\n\n[网址](https://example.com) [图片](photo.png) [邮件](mailto:writer@example.com)',
        },
        { path: '/notes/乙.md', content: '[[丙]]' },
        { path: '/notes/丙.md', content: '' },
      ],
      '/notes/甲.md',
    );
    expect(graph.neighbors).toHaveLength(0);
    expect(graph.broken).toHaveLength(0);
  });
  it('uses live buffers ahead of duplicate disk paths and supports draft names', () => {
    const graph = deriveGraph(
      [
        { path: '/notes/甲.md', content: '[[草稿]]' },
        { path: '/notes/甲.md', content: '[[旧链接]]' },
        { path: 'draft-uuid', name: '草稿.md', content: '[[甲]]' },
      ],
      '/notes/甲.md',
    );
    expect(graph.current?.content).toBe('[[草稿]]');
    expect(graph.neighbors).toMatchObject([
      { document: { path: 'draft-uuid' }, incoming: 1, outgoing: 1 },
    ]);
    expect(graph.broken).toHaveLength(0);
  });
  it('keeps more than twenty neighbors available to the complete text list', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `n${String(i).padStart(2, '0')}.md`);
    const graph = deriveGraph(
      [
        { path: '/notes/index.md', content: paths.map((path) => `[next](${path})`).join('\n') },
        ...paths.map((path) => ({ path: `/notes/${path}`, content: '' })),
      ],
      '/notes/index.md',
    );
    expect(graph.neighbors).toHaveLength(25);
    expect(graph.neighbors[0].document.path).toBe('/notes/n00.md');
  });
  it('normalizes Windows paths, excludes self anchors, and handles malformed URLs', () => {
    const graph = deriveGraph(
      [
        { path: 'C:\\Notes\\A.md', content: '[self](#标题) [B](b.md) [bad](broken%ZZ.md)' },
        { path: 'c:\\notes\\B.md', content: '' },
      ],
      'c:/notes/a.md',
    );
    expect(graph.selfReferences).toBe(1);
    expect(graph.neighbors).toMatchObject([{ document: { path: 'c:\\notes\\B.md' }, outgoing: 1 }]);
    expect(graph.broken).toEqual(['broken%ZZ.md']);
    expect(deriveGraph([], '/missing.md').current).toBeUndefined();
  });

  it('caps the SVG at twenty keyboard-accessible nodes while keeping the complete list', () => {
    const paths = Array.from({ length: 25 }, (_, index) => `/notes/关联文档${index}.md`);
    const documents = [
      { path: '/notes/index.md', content: paths.map((path) => `[文档](${path})`).join('\n') },
      ...paths.map((path) => ({ path, content: '' })),
    ];
    const opened: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      flushSync(() =>
        root.render(
          createElement(LinkGraph, {
            documents,
            currentPath: '/notes/index.md',
            onOpen: (path) => opened.push(path),
          }),
        ),
      );
      const nodes = host.querySelectorAll<SVGGElement>('svg [role="button"]');
      expect(nodes).toHaveLength(20);
      expect(host.querySelectorAll('.linkgraph-list button')).toHaveLength(25);
      expect(nodes[0].querySelector('title')?.textContent).toContain('/notes/关联文档');
      nodes[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(opened).toHaveLength(1);
      expect(paths).toContain(opened[0]);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });
});
