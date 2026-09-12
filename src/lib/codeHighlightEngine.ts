import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';

export type CodeToken = { from: number; to: number; classes: string };
// Large or pathological blocks retain complete plain text. Coloring must not delay reading.
export const MAX_HIGHLIGHT_LENGTH = 40_000;
export async function codeTokens(source: string, language: string): Promise<CodeToken[]> {
  if (source.length > MAX_HIGHLIGHT_LENGTH) return [];
  const alias =
    ({ shell: 'sh', shellscript: 'sh', csharp: 'c#', yml: 'yaml' } as Record<string, string>)[
      language.toLowerCase()
    ] || language.toLowerCase();
  const description = languages.find(
    (item) => item.name.toLowerCase() === alias || item.alias.includes(alias),
  );
  if (!description) return [];
  const support = await description.load();
  const parse = support.language.parser.startParse(source);
  const deadline = performance.now() + 40;
  let tree;
  while (!(tree = parse.advance())) if (performance.now() > deadline) return [];
  const tokens: CodeToken[] = [];
  highlightTree(tree, classHighlighter, (from, to, classes) => tokens.push({ from, to, classes }));
  return tokens;
}
