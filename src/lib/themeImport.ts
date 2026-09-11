import postcss, { type AtRule, type Container, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';

export const themeLibraryKey = 'markwrite.document-themes.v1';
export const themeLibraryEvent = 'markwrite-document-themes-changed';
export const maxThemeBytes = 1_000_000;
export type ImportedTheme = { id: string; name: string; css: string; createdAt: number };
export type ThemeLibrary = { version: 1; themes: ImportedTheme[]; activeId: string | null };
export type ThemeNotice = 'resources' | 'at-rules' | 'properties' | 'selectors';
export type CompiledTheme = { css: string; notices: ThemeNotice[]; rules: number };
export type ThemeErrorCode = 'size' | 'syntax' | 'empty' | 'name' | 'library' | 'limit';
export class ThemeImportError extends Error {
  constructor(public readonly code: ThemeErrorCode) {
    super(code);
    this.name = 'ThemeImportError';
  }
}
export const emptyThemeLibrary = (): ThemeLibrary => ({ version: 1, themes: [], activeId: null });

// These properties change document typography and appearance, without giving CSS
// control of the app's windows, interaction, positioning, or generated content.
const properties = new Set(
  `color background background-color background-image background-size background-position
  background-repeat background-origin background-clip background-blend-mode
  font font-family font-size font-weight font-style font-variant font-variant-ligatures
  font-variant-numeric font-feature-settings font-variation-settings font-kerning
  line-height letter-spacing word-spacing text-align text-indent text-transform
  text-decoration text-decoration-line text-decoration-color text-decoration-style
  text-decoration-thickness text-underline-offset text-wrap text-wrap-mode text-wrap-style
  text-rendering text-shadow white-space overflow-wrap word-wrap word-break hyphens
  margin margin-top margin-right margin-bottom margin-left margin-block margin-inline
  margin-block-start margin-block-end margin-inline-start margin-inline-end
  padding padding-top padding-right padding-bottom padding-left padding-block padding-inline
  padding-block-start padding-block-end padding-inline-start padding-inline-end
  border border-width border-color border-style border-radius border-collapse border-spacing
  border-top border-right border-bottom border-left border-block border-inline
  border-top-width border-right-width border-bottom-width border-left-width
  border-top-color border-right-color border-bottom-color border-left-color
  border-top-style border-right-style border-bottom-style border-left-style
  box-shadow box-sizing max-width min-width width max-height min-height height
  list-style list-style-type list-style-position list-style-image vertical-align
  table-layout caption-side empty-cells accent-color tab-size -moz-tab-size
  -webkit-font-smoothing -moz-osx-font-smoothing`
    .split(/\s+/)
    .filter(Boolean),
);
const functions = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'calc',
  'min',
  'max',
  'clamp',
  'round',
  'mod',
  'rem',
  'var',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
]);
const pseudoClasses = new Set([
  ':hover',
  ':focus',
  ':focus-visible',
  ':checked',
  ':disabled',
  ':enabled',
  ':empty',
  ':first-child',
  ':last-child',
  ':only-child',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
  ':nth-child',
  ':nth-last-child',
  ':nth-of-type',
  ':nth-last-of-type',
  ':not',
  ':is',
  ':where',
  '::before',
  '::after',
  '::marker',
  '::selection',
  ':before',
  ':after',
  '::first-letter',
  '::first-line',
]);
const editorTags: Record<string, string> = {
  h1: 'cm-h1',
  h2: 'cm-h2',
  h3: 'cm-h3',
  h4: 'cm-h4',
  h5: 'cm-h5',
  h6: 'cm-h6',
  p: 'cm-line',
  blockquote: 'cm-quote-line',
  pre: 'cm-code-line',
  code: 'cm-rich-inlinecode',
  strong: 'cm-rich-strongemphasis',
  b: 'cm-rich-strongemphasis',
  em: 'cm-rich-emphasis',
  i: 'cm-rich-emphasis',
  del: 'cm-rich-strikethrough',
  s: 'cm-rich-strikethrough',
  a: 'cm-rich-link',
};
const typoraClasses: Record<string, string> = {
  'md-fences': 'pre',
  'md-code': 'code',
  'md-table': 'table',
  'md-blockquote': 'blockquote',
};
const safeId = /^[a-z0-9-]{1,80}$/;

function unescapeCss(value: string) {
  return value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex: string, char: string) =>
    hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char,
  );
}

function safeValue(value: string, fontSource = false): boolean {
  const parsed = valueParser(value);
  let safe = true;
  parsed.walk((node) => {
    if (node.type !== 'function') return;
    const name = unescapeCss(node.value).toLowerCase();
    if (name === 'url') {
      const url = unescapeCss(
        valueParser
          .stringify(node.nodes)
          .trim()
          .replace(/^(['"])(.*)\1$/s, '$2'),
      );
      const mime = fontSource
        ? '(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype|vnd.ms-fontobject))'
        : 'image\/(?:png|jpeg|gif|webp|avif)';
      if (!new RegExp(`^data:${mime};base64,[a-z0-9+/=\\s]+$`, 'i').test(url)) safe = false;
      return false;
    }
    if (fontSource) {
      if (!['local', 'format', 'tech'].includes(name)) safe = false;
      return false;
    }
    if (!functions.has(name)) safe = false;
  });
  return safe && !/[<>\u0000]/.test(value);
}

function fontKey(value: string) {
  return unescapeCss(value)
    .trim()
    .replace(/^(['"])(.*)\1$/s, '$2')
    .toLowerCase();
}
function rewriteFonts(value: string, fonts: Map<string, string>) {
  const parsed = valueParser(value);
  // Walk comma-separated font families as groups; font shorthand is handled by
  // also matching individual quoted or single-word family nodes.
  const groups: (typeof parsed.nodes)[] = [[]];
  for (const node of parsed.nodes) {
    if (node.type === 'div' && node.value === ',') groups.push([]);
    else groups.at(-1)!.push(node);
  }
  return groups
    .map((nodes) => {
      const whole = fonts.get(fontKey(valueParser.stringify(nodes)));
      if (whole) return `"${whole}"`;
      for (const node of nodes) {
        if (node.type === 'word' || node.type === 'string') {
          const replacement = fonts.get(fontKey(node.value));
          if (replacement) {
            node.type = 'word';
            node.value = `"${replacement}"`;
          }
        }
      }
      return valueParser.stringify(nodes);
    })
    .join(',');
}

function isDocumentRoot(node: selectorParser.Node) {
  return (
    (node.type === 'tag' && ['html', 'body'].includes(node.value.toLowerCase())) ||
    (node.type === 'id' && node.value === 'write') ||
    (node.type === 'class' && node.value === 'markdown-body') ||
    (node.type === 'pseudo' && node.value === ':root')
  );
}

function scopedSelectors(source: string, scope: string, editor: boolean): string[] {
  const output: string[] = [];
  const ast = selectorParser().astSync(source);
  ast.each((selector) => {
    if (selector.nodes.length > 100) return;
    const copy = selector.clone();
    // Strip only a leading chain of document roots, never a descendant selector.
    // A sibling combinator after a root is rejected rather than allowed to
    // select outside the bounded document container.
    while (copy.nodes.length) {
      const boundary = copy.nodes.findIndex((node) => node.type === 'combinator');
      const compound = copy.nodes.slice(0, boundary < 0 ? undefined : boundary);
      if (!compound.some(isDocumentRoot)) break;
      if (compound.some((node) => node.type === 'pseudo' && node.value !== ':root')) return;
      for (const node of compound) node.remove();
      const combinator = copy.first;
      if (combinator?.type === 'combinator') {
        if (![' ', '>'].includes(combinator.value)) return;
        combinator.remove();
      }
    }
    let valid = true;
    copy.walk((node) => {
      if (isDocumentRoot(node) || node.type === 'nesting' || node.type === 'comment') valid = false;
      if (node.type === 'pseudo' && !pseudoClasses.has(node.value.toLowerCase())) valid = false;
      if (node.type === 'combinator' && ![' ', '>', '+', '~'].includes(node.value)) valid = false;
      if (node.type === 'class' && typoraClasses[node.value])
        node.replaceWith(selectorParser.tag({ value: typoraClasses[node.value] }));
    });
    if (!valid || copy.first?.type === 'combinator') return;
    if (editor)
      copy.walkTags((node) => {
        const mapped = editorTags[node.value.toLowerCase()];
        if (mapped) node.replaceWith(selectorParser.className({ value: mapped }));
      });
    output.push(copy.nodes.length ? `${scope} ${copy.toString().trim()}` : scope);
  });
  return output;
}

/** Compiles untrusted theme text. Every emitted rule is reconstructed from an
 * allowlisted AST; the original source is never inserted into a style element. */
export function compileDocumentTheme(source: string, id: string, preview = false): CompiledTheme {
  if (!safeId.test(id)) throw new ThemeImportError('library');
  if (new TextEncoder().encode(source).length > maxThemeBytes) throw new ThemeImportError('size');
  let input: postcss.Root;
  try {
    input = postcss.parse(source, { from: undefined });
  } catch {
    throw new ThemeImportError('syntax');
  }
  const output = postcss.root();
  const notices = new Set<ThemeNotice>();
  const fonts = new Map<string, string>();
  const reader = preview
    ? `:root [data-theme-preview="${id}"] .theme-preview-document`
    : ':root [data-custom-document-theme] .reader.markdown-body';
  const editor = ':root [data-custom-document-theme] .editor-host:not(.source-mode) .cm-content';
  let rules = 0;
  input.walkAtRules((rule) => {
    if (unescapeCss(rule.name).toLowerCase() !== 'font-face') return;
    for (const node of rule.nodes || []) {
      if (node.type !== 'decl' || unescapeCss(node.prop).toLowerCase() !== 'font-family') continue;
      const key = fontKey(node.value);
      if (!fonts.has(key)) fonts.set(key, `mw-theme-${id}-${fonts.size}`);
    }
  });
  function declarations(rule: Rule | AtRule, destination: Rule | AtRule, fontFace = false) {
    for (const node of rule.nodes || []) {
      if (node.type !== 'decl') {
        if (node.type !== 'comment') notices.add('properties');
        continue;
      }
      const property = unescapeCss(node.prop).toLowerCase();
      const allowed = fontFace
        ? [
            'font-family',
            'src',
            'font-weight',
            'font-style',
            'font-stretch',
            'font-display',
            'unicode-range',
          ].includes(property)
        : properties.has(property) || /^--[a-z0-9_-]+$/i.test(property);
      if (!allowed) {
        notices.add('properties');
        continue;
      }
      if (!safeValue(node.value, fontFace && property === 'src')) {
        notices.add('resources');
        continue;
      }
      // Negative or computed margins/indentation could shift text over another
      // surface. They are intentionally excluded from imported document themes.
      if (
        (property.startsWith('margin') || property === 'text-indent') &&
        /-|\(|var\s*\(/i.test(node.value)
      ) {
        notices.add('properties');
        continue;
      }
      let value = node.value;
      if (fontFace && property === 'font-family') value = `"${fonts.get(fontKey(value))}"`;
      else if (
        property === 'font-family' ||
        property === 'font' ||
        (property.startsWith('--') && (property.includes('font') || fonts.has(fontKey(value))))
      )
        value = rewriteFonts(value, fonts);
      destination.append(postcss.decl({ prop: property, value, important: node.important }));
    }
  }
  function walk(container: Container, target: Container, depth = 0) {
    if (depth > 8) {
      notices.add('at-rules');
      return;
    }
    for (const node of container.nodes || []) {
      if (node.type === 'comment') continue;
      if (node.type === 'rule') {
        let selectors: string[];
        try {
          selectors = scopedSelectors(node.selector, reader, false);
          if (!preview) selectors.push(...scopedSelectors(node.selector, editor, true));
        } catch {
          notices.add('selectors');
          continue;
        }
        if (!selectors.length) {
          notices.add('selectors');
          continue;
        }
        const rule = postcss.rule({ selector: selectors.join(',\n') });
        declarations(node, rule);
        if (rule.nodes.length) {
          target.append(rule);
          rules++;
        }
      } else if (node.type === 'atrule') {
        const name = unescapeCss(node.name).toLowerCase();
        if (name === 'font-face') {
          const rule = postcss.atRule({ name: 'font-face' });
          declarations(node, rule, true);
          const src = rule.nodes?.find((child) => child.type === 'decl' && child.prop === 'src');
          const family = rule.nodes?.find(
            (child) => child.type === 'decl' && child.prop === 'font-family',
          );
          if (src && family) target.append(rule);
          else notices.add('resources');
        } else if (
          ['media', 'supports'].includes(name) &&
          /^[\w\s():.,%/!<>=+-]+$/.test(node.params) &&
          !/url|import|selector|\\/i.test(node.params)
        ) {
          const group = postcss.atRule({ name, params: node.params });
          walk(node, group, depth + 1);
          if (group.nodes?.length) target.append(group);
        } else notices.add('at-rules');
      } else notices.add('properties');
    }
  }
  walk(input, output);
  if (!rules) throw new ThemeImportError('empty');
  // Painting is clipped at the document, even for wide shadows or pseudo text.
  const bounds = postcss.rule({ selector: preview ? reader : `${reader}, ${editor}` });
  for (const [prop, value] of Object.entries({
    contain: 'paint',
    isolation: 'isolate',
    position: 'relative',
  }))
    bounds.append(postcss.decl({ prop, value, important: true }));
  output.append(bounds);
  return { css: output.toString(), notices: [...notices], rules };
}

export function createImportedTheme(name: string, css: string): ImportedTheme {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 80) throw new ThemeImportError('name');
  const theme = { id: crypto.randomUUID(), name: cleanName, css, createdAt: Date.now() };
  compileDocumentTheme(css, theme.id);
  return theme;
}

export function validateLibrary(value: unknown): ThemeLibrary {
  if (!value || typeof value !== 'object') throw new ThemeImportError('library');
  const library = value as ThemeLibrary;
  if (
    library.version !== 1 ||
    !Array.isArray(library.themes) ||
    library.themes.length > 20 ||
    (library.activeId !== null && typeof library.activeId !== 'string')
  )
    throw new ThemeImportError('library');
  const ids = new Set<string>();
  for (const theme of library.themes) {
    if (
      !theme ||
      typeof theme.id !== 'string' ||
      !safeId.test(theme.id) ||
      ids.has(theme.id) ||
      typeof theme.name !== 'string' ||
      !theme.name.trim() ||
      theme.name.length > 80 ||
      typeof theme.css !== 'string' ||
      !Number.isFinite(theme.createdAt)
    )
      throw new ThemeImportError('library');
    ids.add(theme.id);
    compileDocumentTheme(theme.css, theme.id);
  }
  if (library.activeId !== null && !ids.has(library.activeId))
    throw new ThemeImportError('library');
  return {
    version: 1,
    themes: library.themes.map((theme) => ({ ...theme })),
    activeId: library.activeId,
  };
}
export function loadThemeLibrary(): ThemeLibrary {
  const saved = localStorage.getItem(themeLibraryKey);
  if (!saved) return emptyThemeLibrary();
  if (new TextEncoder().encode(saved).length > 3_000_000) throw new ThemeImportError('library');
  try {
    return validateLibrary(JSON.parse(saved));
  } catch {
    throw new ThemeImportError('library');
  }
}
export function saveThemeLibrary(library: ThemeLibrary): void {
  if (library.themes.length > 20) throw new ThemeImportError('limit');
  const valid = validateLibrary(library);
  const json = JSON.stringify(valid);
  if (new TextEncoder().encode(json).length > 3_000_000) throw new ThemeImportError('limit');
  localStorage.setItem(themeLibraryKey, json);
  window.dispatchEvent(new Event(themeLibraryEvent));
}
export function resetThemeLibrary(): void {
  localStorage.removeItem(themeLibraryKey);
  window.dispatchEvent(new Event(themeLibraryEvent));
}
