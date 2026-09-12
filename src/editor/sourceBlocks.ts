import type Token from 'markdown-it/lib/token.mjs';
import { createMarkdownParser, markdownConfiguration } from '../lib/markdownParser';

/** Source maps from the same CommonMark block parser used by reading/export.
 * Block discovery must not run Marked's whole-document regular expressions
 * on each keystroke: those can stall JavaScriptCore on ordinary long documents.
 */
export function sourceBlocks(source: string) {
  const parser = createMarkdownParser(markdownConfiguration());
  const tokens: Token[] = [];
  parser.block.parse(source, parser, {}, tokens);
  const offsets = [0];
  for (let n = 0; n < source.length; n++) if (source[n] === '\n') offsets.push(n + 1);
  return tokens
    .filter((token) => token.level === 0 && token.nesting !== -1 && token.map)
    .map((token) => {
      const [fromLine, toLine] = token.map!;
      const from = offsets[fromLine] ?? source.length;
      const raw = source.slice(from, offsets[toLine] ?? source.length).replace(/\n+$/, '');
      return {
        type: token.type,
        from,
        to: from + raw.length,
        fromLine: fromLine + 1,
        toLine: toLine + 1,
        raw,
        info: token.info.trim(),
      };
    });
}
