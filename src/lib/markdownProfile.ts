import type { MarkdownParseOptions } from './markdownParser';
import type { Settings } from './types';
export const markdownProfiles = ['technical', 'github', 'commonmark'] as const;
export type MarkdownProfile = (typeof markdownProfiles)[number];
export function markdownProfileOptions(
  settings: Pick<Settings, 'markdownProfile' | 'markdownCompatibility'>,
): MarkdownParseOptions {
  const plain = settings.markdownProfile === 'commonmark';
  return {
    flavor: plain ? 'commonmark' : 'gfm',
    math: !plain && settings.markdownProfile !== 'github',
    footnotes: !plain,
    compatibility: !plain && settings.markdownCompatibility === true,
  };
}
