import { beforeEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  documentReferences,
  pathKey,
  relativeDocument,
  updateRecents,
  readRecents,
  wikiTargets,
} from '../src/lib/workspace';
import {
  parseExtension,
  starterExtension,
  saveExtensions,
  loadExtensions,
} from '../src/lib/extensions';
import { configureInlineSyntax, renderMarkdown } from '../src/lib/markdown';
import { defaultSettings, readSession, writeSession } from '../src/lib/recovery';
beforeEach(() => {
  localStorage.clear();
  configureInlineSyntax([]);
});
describe('document navigation', () => {
  const documents = [
    {
      path: '/notes/甲.md',
      content: '[[乙#标题]]\n\n#日记\n\n`#不是标签`\n\n```md\n[[代码链接]]\n```',
    },
    { path: '/notes/乙.md', content: '# 标题' },
    { path: '/notes/sub/乙.md', content: '同名' },
  ];
  it('surfaces duplicate link names and resolves relative targets', () => {
    expect(wikiTargets('乙#标题', '/notes/甲.md', documents)).toHaveLength(2);
    expect(wikiTargets('./乙.md', '/notes/甲.md', documents).map((d) => d.path)).toEqual([
      '/notes/乙.md',
    ]);
  });
  it('resolves unsaved documents by name', () => {
    expect(
      wikiTargets('草稿', undefined, [{ path: 'uuid', name: '草稿.md', content: '' }]),
    ).toHaveLength(1);
  });
  it('indexes real links and tags without code examples', () => {
    expect(documentReferences(documents[0].content)).toEqual({
      links: [{ target: '乙#标题', wiki: true }],
      tags: ['日记'],
    });
    expect(backlinks('/notes/乙.md', documents).map((d) => d.path)).toEqual(['/notes/甲.md']);
  });
  it('normalizes Windows keys while preserving Linux case sensitivity', () => {
    expect(pathKey('C:\\笔记\\子目录\\..\\甲.md')).toBe('c:/笔记/甲.md');
    expect(pathKey('/Notes/a.md')).not.toBe(pathKey('/notes/a.md'));
    expect(relativeDocument('C:\\笔记\\a.md', 'C:\\笔记\\子目录\\b.md')).toBe('子目录/b.md');
  });
  it('caps and removes recent records without opening or creating files', () => {
    for (let i = 0; i < 35; i++) updateRecents(`/notes/${i}.md`);
    expect(readRecents()).toHaveLength(30);
    updateRecents(undefined, '/notes/34.md');
    expect(readRecents().some((r) => r.path === '/notes/34.md')).toBe(false);
  });
});
describe('declarative editing extensions', () => {
  it('renders literal custom markers only when enabled and leaves source unmodified', () => {
    const source = '正文 ==高亮文字== 与 %%重点%%。';
    configureInlineSyntax([starterExtension]);
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(source);
    expect(host.querySelectorAll('mark.syntax-highlight')).toHaveLength(2);
    expect(host.querySelector('mark')?.textContent).toBe('高亮文字');
    expect(source).toBe('正文 ==高亮文字== 与 %%重点%%。');
    configureInlineSyntax([{ ...starterExtension, enabled: false }]);
    expect(renderMarkdown(source)).toContain('==高亮文字==');
  });
  it('escapes injected HTML inside custom syntax and keeps code examples literal', () => {
    configureInlineSyntax([starterExtension]);
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(
      '==<img src=x onerror=alert(1)>==\n\n`==literal==`\n\n```md\n%%literal%%\n```',
    );
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('mark')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(host.querySelectorAll('mark')).toHaveLength(1);
    expect(host.querySelector('code')?.textContent).toBe('==literal==');
  });
  it('rejects malicious, ambiguous, oversized, and malformed syntax definitions', () => {
    for (const bad of [
      null,
      { name: 'x', open: '', close: '%%', color: '#ffffff' },
      { name: 'x', open: '**', close: '**', color: '#ffffff' },
      { name: 'x', open: '%%', close: '%%', color: 'red; background:url(https://example.com)' },
      { name: 'x', open: '%%', close: '%%', color: '#ffffff', renderer: 'alert(1)' },
    ]) {
      expect(() =>
        parseExtension(JSON.stringify({ ...starterExtension, inlineSyntax: [bad] })),
      ).toThrow();
    }
    expect(() =>
      parseExtension(
        JSON.stringify({
          ...starterExtension,
          inlineSyntax: Array(21).fill(starterExtension.inlineSyntax![0]),
        }),
      ),
    ).toThrow();
    expect(() => saveExtensions([starterExtension, { ...starterExtension, name: '重复' }])).toThrow(
      '重复',
    );
    expect(() => parseExtension('null')).toThrow();
  });
  it('stores validated syntax packs and notifies the app to reconfigure renderers', () => {
    let detail: unknown;
    const listener = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener('markwrite-extensions-changed', listener);
    saveExtensions([starterExtension]);
    window.removeEventListener('markwrite-extensions-changed', listener);
    expect(detail).toEqual([starterExtension]);
    expect(loadExtensions()).toEqual([starterExtension]);
    configureInlineSyntax([starterExtension]);
    expect(renderMarkdown('==' + 'x'.repeat(4097) + '==')).not.toContain('<mark');
  });
  it('roundtrips templates without executing content', () =>
    expect(parseExtension(JSON.stringify(starterExtension))).toEqual(starterExtension));
  it('rejects executable and oversized extension definitions', () => {
    expect(() =>
      parseExtension(
        JSON.stringify({ ...starterExtension, script: 'fetch("https://example.com")' }),
      ),
    ).toThrow('不支持脚本');
    expect(() =>
      parseExtension(
        JSON.stringify({
          ...starterExtension,
          snippets: [{ name: 'big', markdown: 'x'.repeat(50_001) }],
        }),
      ),
    ).toThrow();
  });
});
it('restores a conflict even when buffer matches its last persisted text', () => {
  writeSession(
    [
      {
        id: 'conflict',
        name: 'a.md',
        path: '/a.md',
        content: 'local',
        saved: 'local',
        version: 'old',
        bom: false,
        crlf: false,
        updated: 1,
        status: 'conflict',
      },
    ],
    'conflict',
    defaultSettings,
  );
  expect(readSession()?.docs[0].status).toBe('conflict');
});
