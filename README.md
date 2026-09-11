# 墨页 · Markwrite

一个正文优先、本地优先的 Markdown 桌面编辑器。Linux 为首要平台，采用 **Tauri 2 + React + TypeScript + Rust + CodeMirror 6**。

当前版本：**0.1.1 开发预览**。已修复 v0.1.0 关闭窗口无响应的问题。已实现真实编辑与本地文件操作；尚未达到 PRD 中 v1.0 的全部验收要求。

<img src="public/assets/app-icon.png" width="100" alt="墨页应用图标" />

## 已实现

- 即时渲染、源码、只读模式，共享 Markdown 原文；切换文档保留当前会话的撤销历史。
- 中文文本编辑、快捷键、查找替换、独立文档标签、文件树、大纲与工作区内容搜索。
- 标题、列表、任务勾选、代码高亮、表格预览及基本行列增删。
- KaTeX 公式、Mermaid 图表；阅读与 HTML 导出使用相同语法处理。
- 本地文件打开、新建、重命名、保存和另存为；已有路径文档可自动保存。
- Rust 文件服务校验磁盘版本，冲突时暂停覆盖；同目录临时文件替换与上一个磁盘版本的恢复副本。
- 会话草稿恢复；应用主动报告本地存储失败。
- 粘贴／拖入图片：已保存文档写入 `assets/`；未命名草稿使用内嵌图片，避免断链。
- HTML 导出嵌入本地图片、公式字体和静态图表，便于离线查看。
- 浅色、深色与系统主题；正文宽度、字号、行高、字体风格、专注模式。
- 生成的应用图标、Linux 桌面入口脚本及 Debian 打包配置。

## 使用

安装 `.deb` 后从应用菜单启动；若使用预构建目录，可执行：

```bash
./scripts/launch.sh
./scripts/install-desktop.sh
```

第二个命令会把快捷方式放到用户应用菜单和桌面，不需要管理员权限。预构建目录应保留在固定位置，否则快捷方式需要重建。某些 GNOME 环境首次打开快捷方式需要右键选择“允许启动”。

初次打开提供可编辑的示例文档。按 **Ctrl+O** 打开文件，或通过左栏打开工作文件夹。新文档是本地草稿，按 **Ctrl+S** 选择路径后才会成为磁盘上的 Markdown 文件。

### 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 新建／打开／保存 | Ctrl+N / Ctrl+O / Ctrl+S |
| 快速打开／命令面板 | Ctrl+P / Ctrl+K |
| 文内查找／全文搜索 | Ctrl+F / Ctrl+Shift+F |
| 撤销／重做 | Ctrl+Z / Ctrl+Shift+Z |
| 关闭文档／设置 | Ctrl+W / Ctrl+, |
| 隐藏侧栏／退出专注 | Ctrl+\ / Esc |

### 冲突与恢复

文件被其他应用修改时，应用保留当前缓冲区。点击“比较版本”，可采用磁盘内容、将当前内容另存为，或显式保存当前版本。

Rust 文件服务在替换已存在文件前，将旧内容保存在应用数据目录下的 `recovery/` 中，文件名是路径的 SHA-256。每个原文件当前只保留一个旧版本，并非完整历史系统。应用会话草稿保存在 WebView 本地存储。完整历史 UI、差异高亮和多版本管理属于后续工作。

## 开发

推荐 Node.js 22 或更新的 LTS 版本、Rust stable，以及 Tauri 2 的 Linux 开发依赖。具体版本由 `package-lock.json` 与 `src-tauri/Cargo.lock` 锁定。

Ubuntu 22.04 / 24.04 常用依赖：

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
npm ci
npm run tauri dev
```

浏览器预览：

```bash
npm run dev
# http://127.0.0.1:1420
```

浏览器预览使用 File System Access API 或文件下载回退，不能代替 Linux WebView 验证。浏览器重启后需重新选择文件以恢复文件句柄，文件重命名仅在桌面版提供。

构建与检查：

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

构建的 `.deb` 位于 Cargo target 目录下的 `release/bundle/deb/`。`bin/` 仅用于本机预构建产物，不纳入 Git。

## 当前限制

- 当前是开发预览；自动化插入中文已经验证，真实 Fcitx5 / IBus 候选词组合、Wayland、多屏缩放和长期写作还需要验收。
- 即时渲染在活动段落显示语法；表格点击后进入源码编辑。大于约 300KB 的文档暂停即时渲染，文件读取上限 32MB。尚未通过 PRD 的大文档性能门槛。
- 行内公式目前在阅读模式渲染；完整的即时渲染公式编辑体验仍在完善。
- 新文档附件暂时内嵌为 data URI，首次保存后尚不会自动迁移到 `assets/`；已保存文档的新附件正常写入附件目录。
- 搜索最多返回 500 条；后台结果可丢弃，但 Rust 扫描尚未实现执行中的任务取消。文件变化当前通过轮询和窗口聚焦检测。
- 支持 UTF-8（含 BOM），保留已有 CRLF。非 UTF-8 文件拒绝覆盖，暂不提供编码转换器。
- 文档内脚本不会执行。网络图片默认阻止，目前不提供主动加载入口。SVG 附件暂不支持。
- HTML 导出支持离线资源；PDF / DOCX、双链、完整历史、Git UI、AI 和插件仍未实现。
- 原子替换和写前版本校验减少文件损坏与覆盖风险，但不提供针对任意外部进程的跨进程文件锁。
- 首版代码支持 Linux 文件关联打开；第二实例合并到当前窗口尚未实现。

## 资料

- [产品需求](docs/PRD.md)
- [验证记录与后续工作](docs/VALIDATION.md)
- [图标生成说明](docs/icon-generation.md)

名称与视觉标识为本轮开发暂定，可后续调整。尚未选择开源许可证。
