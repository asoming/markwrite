import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/platform';
import DiffView from './DiffView';
export default function AiPanel({
  selection,
  onApply,
}: {
  selection: string;
  onApply: (replacement: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(''),
    [model, setModel] = useState(''),
    [apiKey, setApiKey] = useState(''),
    [instruction, setInstruction] = useState('润色这段文字，保留原意与 Markdown 格式。');
  const [result, setResult] = useState(''),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const request = useRef(0);
  async function submit() {
    setLoading(true);
    setError('');
    const id = ++request.current;
    try {
      const response = await invoke<{ text: string }>('ai_transform', {
        request: { endpoint, model, apiKey, instruction, selection },
      });
      if (id === request.current) setResult(response.text);
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  return (
    <div className="ai-panel">
      <p className="panel-note">
        只发送下面选中的文字和操作说明。点击“发送并预览”才会联系你配置的服务；密钥仅保留到此窗口关闭。支持兼容
        Chat Completions 的远程服务和本机模型。
      </p>
      <label>
        API 完整地址
        <input
          aria-label="AI API 地址"
          placeholder="https://服务地址/v1/chat/completions"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <div className="ai-credentials">
        <label>
          模型
          <input aria-label="AI 模型" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          API 密钥（本机服务可留空）
          <input
            aria-label="AI API 密钥"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
      </div>
      <label>
        操作说明
        <textarea
          aria-label="AI 操作说明"
          rows={2}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <details open>
        <summary>将发送的选区 · {selection.length} 字符</summary>
        <pre className="ai-selection">{selection || '请关闭此窗口，在正文中选择文字后重试。'}</pre>
      </details>
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {!desktop && <p>请在桌面版使用模型连接。</p>}
      <div className="panel-actions">
        <button
          className="primary"
          disabled={!desktop || !selection || !endpoint || !model || loading}
          onClick={() => void submit()}
        >
          {loading ? '正在生成…' : '发送并预览修改'}
        </button>
        {loading && (
          <button
            onClick={() => {
              request.current++;
              setLoading(false);
            }}
          >
            停止等待
          </button>
        )}
      </div>
      {result && (
        <>
          <h4>修改预览</h4>
          <DiffView before={selection} after={result} />
          <div className="panel-actions">
            <button onClick={() => setResult('')}>舍弃</button>
            <button className="primary" onClick={() => onApply(result)}>
              接受修改（可撤销）
            </button>
          </div>
        </>
      )}
    </div>
  );
}
