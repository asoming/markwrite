# Windows 支持

目标环境为 Windows 10 / 11 x86_64。界面、Markdown 编辑器和导出逻辑与 Linux
共用；桌面外壳使用 Tauri 2 和系统 WebView2。安装器提供简体中文和英文，默认
安装到当前用户目录，建立开始菜单入口并注册 Markdown 文件关联。

## 获取安装包

打开仓库的 **Actions → Desktop builds**，选择与当前代码提交对应且 Windows
任务成功的运行，下载 `markwrite-windows-x86_64`，解压后运行 `*-setup.exe`。
GitHub 私有仓库的下载需要登录有权限的账号。工作流保留构建产物 30 天。

若系统没有 WebView2，安装器会下载 Microsoft 官方引导安装程序，因此首次
安装可能需要联网。已有 WebView2 后，编辑、本地附件与 PDF / DOCX 导出均
不依赖网络。安装包目前没有商业代码签名证书，Windows 可能显示来源提示。

## 本机开发

安装 Node.js 24、Rust stable（MSVC 工具链）、Visual Studio C++ Build Tools
和 WebView2 后，在项目目录运行：

```powershell
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri -- build --config src-tauri/tauri.windows.conf.json --bundles nsis
```

产物在 `src-tauri/target/release/bundle/nsis/`。详情可参考
[Tauri 官方 Windows 安装器文档](https://v2.tauri.app/distribute/windows-installer/)
及[开发环境前置条件](https://v2.tauri.app/start/prerequisites/)。

## 验证边界

CI 在 Windows 原生 runner 中运行前端测试、Rust 测试并构建 NSIS 安装包，
随后启动应用，等待窗口出现并发送系统关闭消息，检查能否正常退出。
只有对应提交的 Windows 任务成功才代表该版本通过构建验证；工作流配置本身
不是兼容性证明。实际安装、启动、关闭、系统文件对话框、中文输入法候选、
拖放、DPI 缩放及 PDF / DOCX 在目标阅读器中的效果仍需 Windows 桌面验收。
Linux 上的验证结果不能代替这些检查。

## 0.2.0 已验证记录

[CI 运行](https://github.com/asoming/markwrite/actions/runs/34575537706) 已通过 Windows 原生测试、NSIS 构建、静默安装、安装后的窗口启动/关闭和卸载命令检查。下载 [v0.2.0 安装包](https://github.com/asoming/markwrite/releases/tag/v0.2.0)。这不替代目标电脑的中文输入法、缩放、拖放、文件关联及手动安装向导验收。
