import { collectInlineSyntax, parseInlineSyntax, type InlineSyntax } from './syntax';
export type Snippet = { name: string; markdown: string };
export type ExtensionPack = {
  version: 1;
  name: string;
  description?: string;
  snippets: Snippet[];
  inlineSyntax?: InlineSyntax[];
  enabled: boolean;
};
const key = 'markwrite.extensions.v1';
export function parseExtension(json: string): ExtensionPack {
  if (json.length > 250_000) throw new Error('扩展文件最多 250KB。');
  const value = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('扩展必须是 JSON 对象。');
  if (
    Object.keys(value).some(
      (k) => !['version', 'name', 'description', 'snippets', 'inlineSyntax', 'enabled'].includes(k),
    )
  )
    throw new Error('仅支持声明式文字片段和行内语法，不支持脚本、网络或文件权限。');
  if (
    value.version !== 1 ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > 80 ||
    (value.snippets !== undefined && (!Array.isArray(value.snippets) || value.snippets.length > 50))
  )
    throw new Error('扩展需要 version: 1、名称和最多 50 个 snippets。');
  const snippets = value.snippets || [];
  if (
    snippets.some((s: unknown) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return true;
      const snippet = s as Record<string, unknown>;
      return (
        Object.keys(snippet).some((k) => !['name', 'markdown'].includes(k)) ||
        typeof snippet.name !== 'string' ||
        !snippet.name.trim() ||
        snippet.name.length > 80 ||
        typeof snippet.markdown !== 'string' ||
        snippet.markdown.length > 50_000
      );
    })
  )
    throw new Error('每个片段只接受名称和 Markdown 内容，最多 50KB。');
  if (
    value.inlineSyntax !== undefined &&
    (!Array.isArray(value.inlineSyntax) || value.inlineSyntax.length > 20)
  )
    throw new Error('每个扩展最多包含 20 条 inlineSyntax 规则。');
  const rules: InlineSyntax[] | undefined = value.inlineSyntax?.map(parseInlineSyntax);
  if (rules) collectInlineSyntax([{ enabled: true, inlineSyntax: rules }]);
  return {
    version: 1,
    name: value.name.trim(),
    description: typeof value.description === 'string' ? value.description.slice(0, 500) : '',
    snippets: snippets.map((s: Snippet) => ({ name: s.name, markdown: s.markdown })),
    enabled: value.enabled !== false,
    ...(rules ? { inlineSyntax: rules } : {}),
  };
}
export function loadExtensions(): ExtensionPack[] {
  try {
    const packs = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(packs) || packs.length > 32) return [];
    const validated = packs.map((p) => parseExtension(JSON.stringify(p)));
    collectInlineSyntax(validated);
    return validated;
  } catch {
    return [];
  }
}
export function saveExtensions(packs: ExtensionPack[]) {
  if (packs.length > 32) throw new Error('最多安装 32 个扩展。');
  const validated = packs.map((pack) => parseExtension(JSON.stringify(pack)));
  collectInlineSyntax(validated);
  const json = JSON.stringify(validated);
  if (json.length > 2_000_000) throw new Error('扩展总容量最多 2MB。');
  localStorage.setItem(key, json);
  window.dispatchEvent(new CustomEvent('markwrite-extensions-changed', { detail: validated }));
}
export const starterExtension: ExtensionPack = {
  version: 1,
  name: '日常写作',
  description: '会议、项目和读书模板；使用 ==文字== 高亮，或 %%文字%% 标记重点。',
  enabled: true,
  inlineSyntax: [
    { name: '高亮', open: '==', close: '==', color: '#fff0a6' },
    { name: '重点', open: '%%', close: '%%', color: '#dae7ff' },
  ],
  snippets: [
    {
      name: '会议记录',
      markdown:
        '# 会议记录\n\n## 议题\n\n{{selection}}\n\n## 决议\n\n- [ ] 待办事项\n\n## 后续安排\n',
    },
    {
      name: '项目说明',
      markdown:
        '# 项目名称\n\n## 目标\n\n{{selection}}\n\n## 使用方法\n\n## 计划\n\n- [ ] 第一项工作\n',
    },
    {
      name: '读书笔记',
      markdown: '# 读书笔记\n\n## 关键观点\n\n{{selection}}\n\n## 我的理解\n\n## 可以尝试的行动\n',
    },
  ],
};
