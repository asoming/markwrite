import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeTokens, MAX_HIGHLIGHT_LENGTH } from '../src/lib/codeHighlightEngine';
import { highlightCodeBlocks } from '../src/lib/codeHighlight';
import { renderMarkdown } from '../src/lib/markdown';
afterEach(() => vi.unstubAllGlobals());
describe('code coloring without changing source text', () => {
  it.each([
    ['python', 'def greet(name):\n    return "你好 " + name # comment'],
    ['typescript', 'const value: number = 42;'],
    ['rust', 'fn main() { let count = 42; }'],
    ['cpp', 'int main() { return 0; }'],
    ['json', '{"enabled": true, "count": 3}'],
    ['yaml', 'enabled: true\ncount: 3'],
    ['bash', 'echo "hello"'],
  ])('recognizes %s with bounded, ordered token ranges', async (language, source) => {
    const spans = await codeTokens(source, language);
    expect(spans.length).toBeGreaterThan(0);
    let end = 0;
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(end);
      expect(span.to).toBeLessThanOrEqual(source.length);
      expect(span.classes).toMatch(/^tok-/);
      end = span.to;
    }
  });
  it('keeps unknown languages and giant blocks plain', async () => {
    expect(await codeTokens('anything', 'unknown-language')).toEqual([]);
    expect(await codeTokens('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'python')).toEqual([]);
  });
  it('colors safe DOM without interpreting code markup or changing copied text', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: unknown) => void;
        postMessage(value: { id: number; source: string; language: string }) {
          void codeTokens(value.source, value.language).then((tokens) =>
            this.onmessage?.({ data: { id: value.id, tokens } }),
          );
        }
      },
    );
    const root = document.createElement('article');
    const source = 'const html = "<img src=x onerror=alert(1)>";';
    root.innerHTML = renderMarkdown('```js\n' + source + '\n```');
    await highlightCodeBlocks(root);
    expect(root.querySelector('.tok-keyword')).not.toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('code')!.textContent).toBe(source);
    const html = root.innerHTML;
    await highlightCodeBlocks(root);
    expect(root.innerHTML).toBe(html);
  });
});
