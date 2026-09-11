import { useState } from 'react';
import {
  loadExtensions,
  parseExtension,
  saveExtensions,
  starterExtension,
  type ExtensionPack,
} from '../lib/extensions';
import { download } from '../lib/platform';
export default function ExtensionsPanel({
  onInsert,
  onError,
}: {
  onInsert: (markdown: string) => void;
  onError: (text: string) => void;
}) {
  const [packs, setPacks] = useState(loadExtensions),
    [candidate, setCandidate] = useState<ExtensionPack>();
  const [json, setJson] = useState(JSON.stringify(starterExtension, null, 2));
  function save(next: ExtensionPack[]) {
    try {
      saveExtensions(next);
      setPacks(next);
    } catch (error) {
      onError(`无法保存扩展：${String(error)}`);
    }
  }
  return (
    <div className="extensions-panel">
      <p className="panel-note">
        导入可复用的文字片段与自定义行内标记。片段可使用 {'{{selection}}'}{' '}
        代表选中文字。语法规则只定义成对标记和高亮颜色，原文仍是普通
        Markdown；停用扩展即可显示原始标记。扩展不执行代码，也不能读取文件或联网。
      </p>
      {packs.map((pack, i) => (
        <section className="extension-card" key={i}>
          <header>
            <label>
              <input
                type="checkbox"
                checked={pack.enabled}
                onChange={(e) =>
                  save(packs.map((p, n) => (n === i ? { ...p, enabled: e.target.checked } : p)))
                }
              />{' '}
              {pack.name}
            </label>
            <button
              onClick={() =>
                download(JSON.stringify(pack, null, 2), pack.name + '.json', 'application/json')
              }
            >
              导出
            </button>
            <button onClick={() => save(packs.filter((_, n) => n !== i))}>移除</button>
          </header>
          <p>{pack.description}</p>
          <div className="snippet-buttons">
            {pack.inlineSyntax?.map((rule) => (
              <button
                key={`syntax-${rule.name}`}
                disabled={!pack.enabled}
                title={`${rule.open}文字${rule.close}`}
                onClick={() => onInsert(rule.open + '{{selection}}' + rule.close)}
              >
                {rule.name} · {rule.open}
              </button>
            ))}
            {pack.snippets.map((s, n) => (
              <button key={n} disabled={!pack.enabled} onClick={() => onInsert(s.markdown)}>
                {s.name}
              </button>
            ))}
          </div>
        </section>
      ))}
      {!packs.length && (
        <button className="primary panel-wide" onClick={() => save([starterExtension])}>
          启用写作模板与高亮语法
        </button>
      )}
      <details>
        <summary>导入 / 自定义扩展</summary>
        <label className="panel-file">
          选择 JSON 文件
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f)
                try {
                  if (f.size > 250_000) throw new Error('扩展文件最多 250KB。');
                  const text = await f.text();
                  setJson(text);
                  setCandidate(parseExtension(text));
                } catch (error) {
                  onError(String(error));
                }
            }}
          />
        </label>
        <textarea
          aria-label="扩展 JSON"
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setCandidate(undefined);
          }}
          rows={8}
        />
        <button
          className="panel-wide"
          onClick={() => {
            try {
              setCandidate(parseExtension(json));
            } catch (e) {
              onError(String(e));
            }
          }}
        >
          检查并预览
        </button>
      </details>
      {candidate && (
        <div className="extension-preview">
          <h4>将安装：{candidate.name}</h4>
          <p>{candidate.description}</p>
          {candidate.inlineSyntax?.map((rule) => (
            <p className="panel-note" key={rule.name}>
              <strong>{rule.name}</strong>：
              <code>
                {rule.open}文字{rule.close}
              </code>
              ，颜色 {rule.color}
            </p>
          ))}
          {candidate.snippets.map((s, i) => (
            <details key={i}>
              <summary>{s.name}</summary>
              <pre>{s.markdown}</pre>
            </details>
          ))}
          <button
            className="primary panel-wide"
            onClick={() => {
              save([...packs.filter((p) => p.name !== candidate.name), candidate]);
              setCandidate(undefined);
            }}
          >
            安装扩展
          </button>
        </div>
      )}
    </div>
  );
}
