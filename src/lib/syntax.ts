/** Declarative inline notation. No regular expressions, callbacks, URLs, or CSS from packs. */
export type InlineSyntax = { name: string; open: string; close: string; color: string };
export const MAX_INLINE_RULES = 64;
export const MAX_INLINE_CONTENT = 4096;
const RESERVED = new Set(['**', '__', '~~', '[[', ']]', '![', '](', '---']);
export function parseInlineSyntax(value: unknown): InlineSyntax {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('行内语法规则必须是对象。');
  const rule = value as Record<string, unknown>;
  if (Object.keys(rule).some((key) => !['name', 'open', 'close', 'color'].includes(key)))
    throw new Error('行内语法只支持 name、open、close、color，不支持脚本或自定义 CSS。');
  if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 80)
    throw new Error('行内语法需要 1–80 字的名称。');
  for (const key of ['open', 'close'] as const) {
    const marker = rule[key];
    if (
      typeof marker !== 'string' ||
      !/^[!%+=:;?^{}\[\]~_-]{2,8}$/.test(marker) ||
      RESERVED.has(marker)
    )
      throw new Error('标记应为 2–8 个标点，例如 ==、%%、{!；不能覆盖 Markdown 保留标记。');
  }
  if (typeof rule.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(rule.color))
    throw new Error('语法颜色必须是六位十六进制颜色，例如 #fff0a6。');
  return {
    name: rule.name.trim(),
    open: rule.open as string,
    close: rule.close as string,
    color: rule.color.toLowerCase(),
  };
}
export function collectInlineSyntax(
  packs: readonly { enabled: boolean; inlineSyntax?: InlineSyntax[] }[],
): InlineSyntax[] {
  const rules = packs
    .filter((pack) => pack.enabled)
    .flatMap((pack) => (pack.inlineSyntax || []).map(parseInlineSyntax));
  if (rules.length > MAX_INLINE_RULES)
    throw new Error(`启用的行内语法最多 ${MAX_INLINE_RULES} 条。`);
  for (let n = 0; n < rules.length; n++) {
    if (
      rules
        .slice(0, n)
        .some((rule) => rule.open.startsWith(rules[n].open) || rules[n].open.startsWith(rule.open))
    )
      throw new Error(
        `语法标记“${rules[n].open}”与其他已启用规则重复或有重叠，请修改标记或停用其中一个扩展。`,
      );
  }
  return rules;
}
let active: InlineSyntax[] = [];
export function setInlineSyntax(
  packs: readonly { enabled: boolean; inlineSyntax?: InlineSyntax[] }[],
) {
  active = collectInlineSyntax(packs);
  return active.length;
}
export function inlineSyntaxRules(): readonly InlineSyntax[] {
  return active;
}
export function inlineMatch(source: string, rule: InlineSyntax) {
  if (!source.startsWith(rule.open)) return null;
  let end = source.indexOf(rule.close, rule.open.length);
  while (end >= 0 && end <= MAX_INLINE_CONTENT + rule.open.length) {
    let escapes = 0;
    for (let n = end - 1; n >= 0 && source[n] === '\\'; n--) escapes++;
    if (escapes % 2 === 0) break;
    end = source.indexOf(rule.close, end + rule.close.length);
  }
  if (end <= rule.open.length || end > MAX_INLINE_CONTENT + rule.open.length) return null;
  const text = source.slice(rule.open.length, end);
  if (text.includes('\n') || text.includes('\r')) return null;
  return { raw: source.slice(0, end + rule.close.length), text };
}
export function syntaxInk(color: string) {
  const rgb = [1, 3, 5]
    .map((n) => parseInt(color.slice(n, n + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 0.179 ? '#111111' : '#ffffff';
}
