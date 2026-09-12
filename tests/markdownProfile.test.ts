import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { markdownProfileOptions } from '../src/lib/markdownProfile';

describe('source rendering profiles', () => {
  it('renders the five GitHub alerts and leaves unknown markers and code unchanged', () => {
    for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const html = renderMarkdown(`> [!${type}]\n> **正文**`);
      expect(html).toContain(`markdown-alert-${type.toLowerCase()}`);
      expect(html).toContain('<strong>正文</strong>');
    }
    expect(renderMarkdown('> [!PRIVATE]\n> 正文')).not.toContain('markdown-alert');
    expect(renderMarkdown('```md\n> [!NOTE]\n```')).not.toContain('class="markdown-alert');
  });
  it('uses plain CommonMark without silently enabling Wiki, math or alerts', () => {
    const options = markdownProfileOptions({
      markdownProfile: 'commonmark',
      markdownCompatibility: true,
    });
    const html = renderMarkdown('> [!NOTE]\n\n$x^2$ [[file]]\n\n| A |\n| --- |\n| x |', options);
    expect(html).toContain('[!NOTE]');
    expect(html).toContain('$x^2$ [[file]]');
    expect(html).not.toContain('markdown-alert');
    expect(html).not.toContain('<table>');
  });
});
