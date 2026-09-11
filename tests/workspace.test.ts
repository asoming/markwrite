import { beforeEach, describe, expect, it } from 'vitest';
import {
  backlinks,
  documentReferences,
  pathKey,
  relativeDocument,
  resolveDocumentLink,
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
  it('matches canonical extended Windows paths and UNC shares without changing native records', () => {
    const drive = String.raw`\\?\C:\笔记\子目录\..\甲.md`;
    const share = String.raw`\\?\UNC\SERVER\Notes\folder\..\甲.md`;
    expect(pathKey(drive)).toBe(pathKey(String.raw`c:\笔记\甲.md`));
    expect(pathKey(share)).toBe(pathKey(String.raw`\\server\notes\甲.md`));
    expect(pathKey('C:/../../note.md')).toBe('c:/note.md');
    expect(pathKey('//Server/Notes/../../note.md')).toBe('//server/notes/note.md');
    expect(drive).toBe(String.raw`\\?\C:\笔记\子目录\..\甲.md`);
  });
  it('resolves same-volume links with case-insensitive folders and preserves extended paths', () => {
    const from = String.raw`\\?\C:\Notes\文章.md`;
    const to = String.raw`c:\notes\子目录\100% #问题.md`;
    const href = relativeDocument(from, to);
    expect(href).toBe('子目录/100%25 %23问题.md');
    const resolved = resolveDocumentLink(from, href + '#章节');
    expect(resolved.path).toBe(String.raw`\\?\C:\Notes\子目录\100% #问题.md`);
    expect(pathKey(resolved.path)).toBe(pathKey(to));
    expect(resolved.fragment).toBe('章节');
  });
  it('uses portable file URIs across drives and different network shares', () => {
    const from = String.raw`\\?\C:\Notes\文章.md`;
    const destination = String.raw`\\?\D:\资料\100% #目标.md`;
    const href = relativeDocument(from, destination);
    expect(href).toBe('file:///D:/%E8%B5%84%E6%96%99/100%25%20%23%E7%9B%AE%E6%A0%87.md');
    expect(pathKey(resolveDocumentLink(from, href).path)).toBe(pathKey(destination));
    const unc = relativeDocument(
      String.raw`\\Server\First\from.md`,
      String.raw`\\server\Second\子目录\目标.md`,
    );
    expect(unc).toBe('file://server/Second/%E5%AD%90%E7%9B%AE%E5%BD%95/%E7%9B%AE%E6%A0%87.md');
    expect(pathKey(resolveDocumentLink(from, unc).path)).toBe('//server/second/子目录/目标.md');
  });
  it('matches relative, absolute, and cross-drive backlinks against canonical Windows records', () => {
    const from = String.raw`\\?\C:\Notes\甲.md`,
      target = String.raw`\\?\D:\Notes\乙.md`;
    const docs = [
      { path: from, content: '[乙](<' + relativeDocument(from, target) + '>)\n\n[[D:/Notes/乙]]' },
      { path: target, content: '' },
    ];
    expect(backlinks(target, docs).map((doc) => doc.path)).toEqual([from]);
    expect(wikiTargets('D:/notes/乙', from, docs).map((doc) => doc.path)).toEqual([target]);
    expect(wikiTargets('../notes/甲', from, docs).map((doc) => doc.path)).toEqual([from]);
  });
  it('preserves file links through sanitized rendering and never turns images into local loads', () => {
    const href = relativeDocument('C:/from.md', 'D:/Notes/目标.md');
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(
      `[**文件**](<${href}>)\n\n[危险](javascript:alert)\n\n![本地图片](file:///D:/secret.png)`,
    );
    expect(host.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(host.querySelector('a strong')?.textContent).toBe('文件');
    expect(host.querySelectorAll('a')[1].getAttribute('href')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(host.querySelector('[data-local-href]')).toBeNull();
    expect(
      resolveDocumentLink('C:/from.md', host.querySelector('a')!.getAttribute('href')!).path,
    ).toBe('D:/Notes/目标.md');
  });
  it('rejects malformed and executable links and keeps Linux path case intact', () => {
    expect(() => resolveDocumentLink('/notes/a.md', 'javascript:alert(1)')).toThrow();
    expect(() => resolveDocumentLink('/notes/a.md', 'file:///tmp/a%00.md')).toThrow();
    expect(() => resolveDocumentLink('/notes/a.md', 'bad%ZZ.md')).toThrow();
    expect(() => resolveDocumentLink(undefined, '../relative.md')).toThrow();
    expect(() => resolveDocumentLink('C:/from.md', 'D:relative.md')).toThrow();
    expect(resolveDocumentLink('/Notes/a.md', '../Other/B.md').path).toBe('/Other/B.md');
    expect(relativeDocument('/Notes/a.md', '/notes/B.md')).toBe('../notes/B.md');
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
