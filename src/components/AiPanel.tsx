import { t, useI18n } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../lib/platform';
import {
  aiDestination,
  readAiConnection,
  saveAiConnection,
  type AiProtocol,
} from '../lib/aiConnection';
import DiffView from './DiffView';
export default function AiPanel({
  selection,
  onApply,
}: {
  selection: string;
  onApply: (replacement: string) => void;
}) {
  useI18n();
  const [connection, setConnection] = useState(readAiConnection);
  const { endpoint, model, protocol, exactEndpoint } = connection;
  const [apiKey, setApiKey] = useState('');
  const [instruction, setInstruction] = useState(t('润色这段文字，保留原意与 Markdown 格式。'));
  const [result, setResult] = useState(''),
    [loading, setLoading] = useState<'test' | 'generate' | null>(null),
    [error, setError] = useState(''),
    [connectionStatus, setConnectionStatus] = useState('');
  const [rememberKey, setRememberKey] = useState(true);
  const [keyStatus, setKeyStatus] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const keyRevision = useRef(0);
  const request = useRef(0);
  const destination = aiDestination(endpoint, protocol, exactEndpoint);
  useEffect(() => {
    const revision = ++keyRevision.current;
    setApiKey('');
    setKeyStatus('');
    setKeyBusy(false);
    if (!desktop || !destination) return;
    let canceled = false;
    setKeyBusy(true);
    const timer = setTimeout(() => {
      void invoke<string | null>('ai_load_key', { endpoint: destination })
        .then((key) => {
          if (!canceled && revision === keyRevision.current) {
            setApiKey(key || '');
            if (key)
              setKeyStatus(
                t('已从系统凭据库读取密钥', 'Loaded key from the system credential store'),
              );
          }
        })
        .catch((e) => {
          if (!canceled) setKeyStatus(String(e));
        })
        .finally(() => {
          if (!canceled) setKeyBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      canceled = true;
    };
  }, [destination]);
  async function saveConnection() {
    saveAiConnection(connection);
    if (rememberKey && apiKey.trim())
      await invoke('ai_save_key', { endpoint: destination, apiKey: apiKey.trim() });
    setKeyStatus(
      rememberKey && apiKey.trim()
        ? t('配置与密钥已保存，重启后仍可使用', 'Connection and key saved for future sessions')
        : t('配置已保存', 'Connection saved'),
    );
  }
  useEffect(() => {
    // Do not persist URL credentials accidentally pasted into the address field.
    if (destination || !endpoint) saveAiConnection(connection);
    setResult('');
    setError('');
    setConnectionStatus('');
  }, [connection, apiKey, instruction, selection]);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function submit(testing: boolean) {
    setLoading(testing ? 'test' : 'generate');
    setError('');
    setConnectionStatus('');
    setResult('');
    const id = ++request.current;
    try {
      await saveConnection();
      if (id !== request.current) return;
      const response = await invoke<{ text: string }>(
        testing ? 'ai_test_connection' : 'ai_transform',
        {
          request: {
            endpoint,
            model,
            apiKey,
            protocol,
            exactEndpoint: exactEndpoint === true,
            ...(testing ? {} : { instruction, selection }),
          },
        },
      );
      if (id !== request.current) return;
      if (testing)
        setConnectionStatus(t('连接成功，模型已返回文字。', 'Connected. The model returned text.'));
      else setResult(response.text);
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      if (id === request.current) setLoading(null);
    }
  }
  const selectionBytes = new TextEncoder().encode(selection).length;
  const validSelection = selectionBytes > 0 && selectionBytes <= 100_000;
  return (
    <div className="ai-panel">
      <p className="panel-note">
        {t(
          '只有点击按钮才会联系配置的服务。连接测试只发送“回复 OK”，不发送文档；生成仅发送下方选区和说明。勾选记住密钥后保存到系统凭据库，重启后仍可用，文档和备份不包含密钥。',
          'Requests run only when you click. Connection testing sends only “Reply OK”, never document text. Generation sends the selection and instruction below. Remembered keys are stored in the system credential store across restarts, never in documents or backups.',
        )}
      </p>
      <fieldset className="ai-connection-fields" disabled={!!loading}>
        <label>
          {t('接口类型', 'API type')}
          <select
            aria-label={t('AI 接口类型', 'AI API type')}
            value={protocol}
            onChange={(e) =>
              setConnection({ ...connection, protocol: e.target.value as AiProtocol })
            }
          >
            <option value="chat">Chat Completions</option>
            <option value="responses">Responses</option>
            <option value="messages">Anthropic Messages</option>
          </select>
        </label>
        <label>
          {t('API 地址（基础地址或完整接口）', 'API address (base URL or complete endpoint)')}
          <input
            aria-label={t('AI API 地址')}
            placeholder="https://api.example.com/v1"
            value={endpoint}
            onChange={(e) => setConnection({ ...connection, endpoint: e.target.value })}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <label className="ai-exact-url">
          <input
            type="checkbox"
            checked={exactEndpoint === true}
            onChange={(event) =>
              setConnection({ ...connection, exactEndpoint: event.target.checked })
            }
          />
          {t(
            '使用自定义完整路径，不自动补全',
            'Use a custom exact endpoint without path completion',
          )}
        </label>
        <p className="ai-destination">
          {t('实际请求地址', 'Request destination')}：
          <code>
            {destination ||
              t(
                '请输入 HTTPS API 地址，或本机 localhost HTTP 地址；不要附带密钥参数。',
                'Enter an HTTPS API URL or localhost HTTP URL without credentials or query parameters.',
              )}
          </code>
        </p>
        <div className="ai-credentials">
          <label>
            {t('模型 ID', 'Model ID')}
            <input
              aria-label={t('AI 模型')}
              placeholder={t('填写服务商提供的准确模型 ID', 'Exact model ID from your provider')}
              value={model}
              onChange={(e) => setConnection({ ...connection, model: e.target.value })}
            />
          </label>
          <label>
            {t('API 密钥（本机服务可留空）')}
            <input
              aria-label={t('AI API 密钥')}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                keyRevision.current++;
                setApiKey(e.target.value);
              }}
            />
          </label>
        </div>
        <label>
          {t('操作说明')}
          <textarea
            aria-label={t('AI 操作说明')}
            rows={2}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>
      </fieldset>
      <div className="ai-key-controls">
        <label>
          <input
            type="checkbox"
            checked={rememberKey}
            disabled={!!loading || keyBusy}
            onChange={(e) => setRememberKey(e.target.checked)}
          />
          {t('记住 API 密钥（系统凭据库）', 'Remember API key (system credential store)')}
        </label>
        <button
          disabled={!desktop || !destination || !!loading || keyBusy}
          onClick={() => {
            setKeyBusy(true);
            void saveConnection()
              .catch((e) => setKeyStatus(String(e)))
              .finally(() => setKeyBusy(false));
          }}
        >
          {t('保存连接配置', 'Save connection')}
        </button>
        <button
          disabled={!desktop || !destination || !!loading || keyBusy}
          onClick={() => {
            setKeyBusy(true);
            void invoke('ai_delete_key', { endpoint: destination })
              .then(() => {
                keyRevision.current++;
                setApiKey('');
                setKeyStatus(t('已删除保存的密钥', 'Saved key deleted'));
              })
              .catch((e) => setKeyStatus(String(e)))
              .finally(() => setKeyBusy(false));
          }}
        >
          {t('删除已保存密钥', 'Delete saved key')}
        </button>
        {keyStatus && (
          <p role="status" className="panel-note">
            {keyStatus}
          </p>
        )}
      </div>
      <details>
        <summary>
          {t('将发送的选区 ·') + ' '}
          {selection.length}
          {' ' + t('字符')}
        </summary>
        <pre className="ai-selection">
          {selection || t('请关闭此窗口，在正文中选择文字后重试。')}
        </pre>
      </details>
      {!validSelection && (
        <p className="panel-note">
          {selectionBytes
            ? t('选区超过 100KB，请缩小选区。', 'Selection exceeds 100KB; select less text.')
            : t(
                '尚未选择文字。可以先测试连接；生成修改前请返回编辑模式选择文字。',
                'No text selected. You can test the connection now; select text in editing mode before generating changes.',
              )}
        </p>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {connectionStatus && (
        <p className="ai-connected" role="status">
          {connectionStatus}
        </p>
      )}
      {!desktop && <p>{t('请在桌面版使用模型连接。')}</p>}
      <div className="panel-actions">
        <button
          disabled={!desktop || !destination || !model.trim() || !!loading || keyBusy}
          onClick={() => void submit(true)}
        >
          {loading === 'test' ? t('正在测试…', 'Testing…') : t('测试连接', 'Test connection')}
        </button>
        <button
          className="primary"
          disabled={
            !desktop || !validSelection || !destination || !model.trim() || !!loading || keyBusy
          }
          onClick={() => void submit(false)}
        >
          {loading === 'generate' ? t('正在生成…') : t('发送并预览修改')}
        </button>
        {loading && (
          <button
            onClick={() => {
              request.current++;
              setLoading(null);
            }}
          >
            {t('停止等待')}
          </button>
        )}
      </div>
      {result && (
        <>
          <h4>{t('修改预览')}</h4>
          <DiffView before={selection} after={result} />
          <div className="panel-actions">
            <button onClick={() => setResult('')}>{t('舍弃')}</button>
            <button className="primary" onClick={() => onApply(result)}>
              {t('接受修改（可撤销）')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
