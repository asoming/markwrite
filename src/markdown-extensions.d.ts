declare module 'markdown-it-task-lists' {
  import type { MarkdownIt } from 'markdown-it';
  const taskLists: (
    parser: MarkdownIt,
    options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean },
  ) => void;
  export default taskLists;
}
declare module 'commonmark-spec' {
  export const tests: { markdown: string; html: string; section: string; number: number }[];
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
