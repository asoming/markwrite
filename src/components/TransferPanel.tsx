import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop, openExternal } from '../lib/platform';
export default function TransferPanel({
  kind,
  html,
  name,
  onInsert,
}: {
  kind: 'image' | 'publish';
  html?: string;
  name: string;
  onInsert: (url: string) => void;
}) {
  const [endpoint, setEndpoint] = useState(''),
    [apiKey, setApiKey] = useState(''),
    [responsePath, setResponsePath] = useState('url'),
    [fieldName, setFieldName] = useState('file');
  const [file, setFile] = useState<File>(),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [url, setUrl] = useState('');
  async function send() {
    setLoading(true);
    setError('');
    try {
      const response =
        kind === 'image'
          ? await invoke<{ url: string }>('upload_image', {
              request: {
                endpoint,
                apiKey,
                name: file!.name,
                bytes: [...new Uint8Array(await file!.arrayBuffer())],
                responsePath,
                fieldName,
              },
            })
          : await invoke<{ url: string }>('publish_html', {
              request: { endpoint, apiKey, html: html || '', name, responsePath },
            });
      setUrl(response.url);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="ai-panel">
      <p className="panel-note">
        这是通用 HTTP 服务连接。
        {kind === 'image'
          ? '将选中的图片上传到你指定的服务，得到图片链接后再插入。'
          : '将当前文档的 HTML（包括正文与嵌入的图片）发送到你指定的发布服务。'}
        点击下面的发送按钮前不会联网。密钥仅保留到窗口关闭。
      </p>
      <label>
        服务地址
        <input
          aria-label="传输服务地址"
          placeholder="https://你的服务/api/upload"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label>
        Bearer 密钥（可选）
        <input
          aria-label="传输服务密钥"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      {kind === 'image' ? (
        <label>
          图片
          <input
            aria-label="选择上传图片"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            onChange={(e) => {
              setFile(e.target.files?.[0]);
              setUrl('');
            }}
          />
          {file && (
            <small>
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </small>
          )}
        </label>
      ) : (
        <details>
          <summary>
            将发送：{name} · {Math.ceil((html?.length || 0) / 1024)} KB HTML
          </summary>
          <p>内容来自当前编辑缓冲区；本地资源已嵌入，源文件不会被覆盖。</p>
        </details>
      )}
      <details>
        <summary>接口格式</summary>
        <p className="panel-note">
          {kind === 'image'
            ? '使用 multipart/form-data POST 上传文件。'
            : '使用 Content-Type: text/html 的 POST 发送文档。'}
          服务须返回包含链接的 JSON，或使用 Location 响应头。默认读取 JSON 的 url 字段。
        </p>
        <label>
          链接字段路径
          <input
            aria-label="响应链接字段"
            value={responsePath}
            onChange={(e) => setResponsePath(e.target.value)}
          />
        </label>
        {kind === 'image' && (
          <label>
            文件字段名
            <input
              aria-label="上传文件字段"
              value={fieldName}
              onChange={(e) => setFieldName(e.target.value)}
            />
          </label>
        )}
      </details>
      {error && (
        <p role="alert" className="panel-error">
          {error}
        </p>
      )}
      {!desktop && <p>请在桌面版连接服务。</p>}
      <button
        className="primary panel-wide"
        disabled={!desktop || loading || !endpoint || (kind === 'image' && !file)}
        onClick={() => void send()}
      >
        {loading ? '正在发送…' : kind === 'image' ? '上传所选图片' : '发布当前文档'}
      </button>
      {url && (
        <div>
          <p>服务返回链接：</p>
          <input aria-label="返回的链接" readOnly value={url} />
          <div className="panel-actions">
            <button
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .catch(() => setError('复制失败，请手动选择链接复制。'))
              }
            >
              复制链接
            </button>
            {kind === 'image' ? (
              <button className="primary" onClick={() => onInsert(url)}>
                插入到正文
              </button>
            ) : (
              <button onClick={() => void openExternal(url).catch((e) => setError(String(e)))}>
                打开发布页面
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
