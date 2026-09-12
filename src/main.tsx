import React from 'react';
import ReactDOM from 'react-dom/client';
import { prepareSession } from './lib/recovery';
import './styles.css';
import 'katex/dist/katex.min.css';
async function start() {
  const appModule = import('./App');
  let recoveryError = '';
  try {
    await prepareSession();
  } catch {
    recoveryError = '无法读取原生恢复文件。原文件没有被修改，请检查磁盘和应用数据目录权限。';
  }
  if (recoveryError) {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <div className="startup-error" role="alert">
        <h2>恢复文件暂时无法读取</h2>
        <p>{recoveryError}</p>
        <button onClick={() => location.reload()}>重试读取</button>
      </div>,
    );
    return;
  }
  const { default: App } = await appModule;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {recoveryError && (
        <div className="startup-error" role="alert">
          {recoveryError}
        </div>
      )}
      <App />
    </React.StrictMode>,
  );
}
void start();
