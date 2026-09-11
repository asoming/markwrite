import { describe, expect, it } from 'vitest';
import {
  analyzeReferenceChanges,
  movedReferencePath,
  planReferenceChanges,
} from '../src/lib/referenceMaintenance';
import { resolveDocumentLink } from '../src/lib/workspace';

describe('reference maintenance plans', () => {
  it('updates only destinations and keeps labels, title, encoding style and anchor intact', () => {
    const source =
      '[Old name](./old%20file.md#part%202 "Original title")\n[Old name](<old file.md#段落> \'提示\')';
    const result = planReferenceChanges(
      [
        { path: '/notes/index.md', content: source },
        { path: '/notes/old file.md', content: '' },
      ],
      '/notes/old file.md',
      '/notes/new 文件.md',
    );
    expect(result).toEqual([
      {
        path: '/notes/index.md',
        nextPath: '/notes/index.md',
        before: source,
        after:
          '[Old name](./new%20%E6%96%87%E4%BB%B6.md#part%202 "Original title")\n[Old name](<new 文件.md#段落> \'提示\')',
        count: 2,
      },
    ]);
  });
  it('rebases outgoing document and image links when moving the source document', () => {
    const source =
      '[neighbor](b.md#section) ![photo](assets/pic.png) [self](#heading) [web](https://example.com/a.md)';
    const result = planReferenceChanges(
      [{ path: '/notes/a.md', content: source }],
      '/notes/a.md',
      '/notes/sub/a.md',
    );
    expect(result[0]).toMatchObject({ path: '/notes/a.md', nextPath: '/notes/sub/a.md', count: 2 });
    expect(result[0].after).toBe(
      '[neighbor](../b.md#section) ![photo](../assets/pic.png) [self](#heading) [web](https://example.com/a.md)',
    );
  });
  it('renames an entire subtree without changing still-valid internal relative paths', () => {
    const result = planReferenceChanges(
      [
        { path: '/notes/index.md', content: '[a](group/a.md) [outside](group-other/a.md)' },
        {
          path: '/notes/group/a.md',
          content: '[b](b.md) ![image](assets/photo.png) [up](../index.md)',
        },
        { path: '/notes/group/b.md', content: 'unchanged' },
      ],
      '/notes/group',
      '/notes/archive',
    );
    expect(result).toHaveLength(1);
    expect(result[0].after).toBe('[a](archive/a.md) [outside](group-other/a.md)');
    expect(movedReferencePath('/notes/group-other/a.md', '/notes/group', '/notes/archive')).toBe(
      '/notes/group-other/a.md',
    );
  });
  it('leaves inline code, fenced examples, comments and front matter unchanged', () => {
    const source =
      '---\nexample: "[a](old.md)"\n---\n\n`[a](old.md)`\n\n```md\n[a](old.md)\n[ref]: old.md\n```\n\n<!-- <img src="old.md"> -->\n\n[a](old.md)';
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: source }],
      '/notes/old.md',
      '/notes/new.md',
    );
    expect(result[0].after).toBe(source.slice(0, -'[a](old.md)'.length) + '[a](new.md)');
    expect(result[0].count).toBe(1);
  });
  it('locates references inside lists, blockquotes and table cells', () => {
    const source =
      '- [a](old.md)\n  - **[b](old.md)**\n\n> [c](old.md)\n\n| Doc |\n| --- |\n| [d](old.md) |';
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: source }],
      '/notes/old.md',
      '/notes/new.md',
    );
    expect(result[0].after).toBe(source.replaceAll('(old.md)', '(new.md)'));
    expect(result[0].count).toBe(4);
  });
  it('updates unique wiki links while preserving aliases and section suffixes', () => {
    const result = planReferenceChanges(
      [
        { path: '/notes/index.md', content: '[[ old#节 | alias ]] [[./old.md#Section|label]]' },
        { path: '/notes/old.md', content: '' },
      ],
      '/notes/old.md',
      '/notes/new.md',
    );
    expect(result[0].after).toBe('[[ new#节 | alias ]] [[./new.md#Section|label]]');
  });
  it('reports ambiguous wiki titles without guessing their destination', () => {
    const result = analyzeReferenceChanges(
      [
        { path: '/notes/index.md', content: '[[old]] [exact](old.md)' },
        { path: '/notes/old.md', content: '' },
        { path: '/notes/other/old.md', content: '' },
      ],
      '/notes/old.md',
      '/notes/new.md',
    );
    expect(result.changes[0].after).toBe('[[old]] [exact](new.md)');
    expect(result.warnings).toEqual([
      { path: '/notes/index.md', reference: 'old', reason: 'ambiguous-wiki' },
    ]);
  });
  it('uses an explicit relative wiki path if the new title would become ambiguous', () => {
    const result = planReferenceChanges(
      [
        { path: '/notes/index.md', content: '[[old|display]]' },
        { path: '/notes/sub/old.md', content: '' },
        { path: '/notes/other/new.md', content: '' },
      ],
      '/notes/sub/old.md',
      '/notes/sub/new.md',
    );
    expect(result[0].after).toBe('[[sub/new|display]]');
  });
  it('updates reference definitions once and leaves all reference-use forms intact', () => {
    const source =
      '[show][ref] ![photo][image] [ref][]\n\n[ref]: <old.md#head> "keep title"\n[image]: ./assets/pic.png \'picture\'\n';
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: source }],
      '/notes/index.md',
      '/notes/sub/index.md',
    );
    expect(result[0].after).toBe(
      '[show][ref] ![photo][image] [ref][]\n\n[ref]: <../old.md#head> "keep title"\n[image]: ../assets/pic.png \'picture\'\n',
    );
    expect(result[0].count).toBe(2);
  });
  it('updates HTML sources, retaining attributes and avoiding attribute-like text inside titles', () => {
    const source =
      '<img title="description src=\'old.png\'" data-src="old.png" src="assets/a&amp;b.png" width="640" height="320">\n\n<a href=\'old.md#head\'>text</a>';
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: source }],
      '/notes/index.md',
      '/notes/sub/index.md',
    );
    expect(result[0].after).toBe(
      '<img title="description src=\'old.png\'" data-src="old.png" src="../assets/a&amp;b.png" width="640" height="320">\n\n<a href=\'../old.md#head\'>text</a>',
    );
    expect(result[0].count).toBe(2);
  });
  it('handles nested linked images as two separate non-overlapping changes', () => {
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: '[![image](image.png)](target.md "title")' }],
      '/notes/index.md',
      '/notes/sub/index.md',
    );
    expect(result[0].after).toBe('[![image](../image.png)](../target.md "title")');
    expect(result[0].count).toBe(2);
  });
  it('supports Windows extended paths and cross-drive moves using file URIs', () => {
    const result = planReferenceChanges(
      [{ path: String.raw`\\?\C:\Notes\index.md`, content: '[target](old.md#part)' }],
      String.raw`C:\Notes\old.md`,
      String.raw`D:\新资料\new.md`,
    );
    expect(result[0].after).toContain('file:///D:/');
    const href = /\]\(([^)]+)\)/.exec(result[0].after)![1];
    expect(resolveDocumentLink(result[0].nextPath, href).path).toBe('D:/新资料/new.md');
    expect(href.endsWith('#part')).toBe(true);
  });
  it('preserves reserved filename characters and encoded anchors in absolute links', () => {
    const result = planReferenceChanges(
      [{ path: '/notes/index.md', content: '[target](/notes/old.md#part%20one)' }],
      '/notes/old.md',
      '/notes/100% #new.md',
    );
    const href = /\]\(([^)]+)\)/.exec(result[0].after)![1];
    expect(resolveDocumentLink('/notes/index.md', href)).toMatchObject({
      path: '/notes/100% #new.md',
      fragment: 'part one',
    });
  });
  it('prefers the first live buffer for duplicate paths and reports malformed hrefs conservatively', () => {
    const result = analyzeReferenceChanges(
      [
        { path: '/notes/index.md', content: '[current](old.md) [bad](old%ZZ.md)' },
        { path: '/notes/index.md', content: '[stale](old.md)' },
      ],
      '/notes/old.md',
      '/notes/new.md',
    );
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].after).toBe('[current](new.md) [bad](old%ZZ.md)');
    expect(result.warnings[0].reason).toBe('invalid-reference');
  });
});
