# 墨页 · Markwrite

面向 Linux 和 Windows 的本地 Markdown 写作工具。使用 **Tauri 2 + React + TypeScript + Rust + CodeMirror 6**。

当前版本 **0.2.0 功能预览**。新增菜单式排版与可视化表格，保留 Markdown 源码。功能实现不等同于完成 PRD 的全部真机验收；具体状态见 [功能矩阵](docs/FEATURE_MATRIX.md)。

<img src="public/assets/app-icon.png" width="100" alt="墨页应用图标" />

## 不记语法，也可以编辑

- 顶部「文件、编辑、段落、格式、插入、视图、主题、工具、帮助」菜单。
- 标题、粗体、斜体、删除线、代码、引用、列表、任务、缩进、段落移动均可点击完成。
- 链接表单、选择本地图片、可视化表格、对齐与 Excel/TSV 粘贴。
- 公式模板、中文步骤生成流程图；需要精细控制时仍可填写 LaTeX / Mermaid。
- 即时渲染、源码、阅读共用 Markdown 原文，格式操作可撤销。支持富文本转换粘贴与纯文本粘贴。

## 文件与文档管理

- 单文件、工作文件夹、文件树、多文档、最近文件、原生拖入和第二实例转交。
- 创建、重命名、批量移到系统回收站；不会直接永久删除文档。
- 后台大纲与字数统计；可取消的全文搜索，分批显示结果；原生目录监听。
- 文档并排对照、双链 `[[文档#标题|文字]]`、名称冲突选择、反向链接和标签检索。
- 自动保存、磁盘冲突比较、原子替换、历史浏览与可撤销恢复。
- 每篇文件保留最多 50 个历史版本，历史总空间上限 200MiB；这是本机恢复功能，不代替备份。
- 桌面草稿使用原生恢复文件，每 3 秒保底刷新，关闭前等待写入；不受浏览器 localStorage 小配额限制。保留一个前代恢复文件。单会话上限 256MiB。
- 新文档中的内嵌图片保存后迁移到 `assets/`；可设置一直内嵌。迁移失败保留内嵌原图，冲突暂停覆盖。
- 附件引用清单、未引用图片清理预览和回收站。网络图片只有用户点击加载后才请求。

## 输出与扩展

- 离线 HTML（可选目录、明暗主题）、PDF 和 Word DOCX；标准、学术、紧凑模板。
- PDF 自带中文字体，公式与图表使用静态 SVG；DOCX 包含 SVG 与兼容 PNG。具体排版边界见 [导出说明](docs/EXPORTS.md)。
- Git 状态、差异、初始化与选定文件本地提交，不自动推送，不执行仓库 hooks。
- AI：用户配置兼容 Chat Completions 的服务或本机模型，只发送明确选中的内容；先预览差异，再接受，支持撤销。密钥不持久化。
- 编辑扩展：检查、导入、启停和导出 JSON 文字片段。扩展不能执行脚本、读取文件或联网。
- 明暗主题、正文/代码字体、字号、行高、宽度、阅读预设、自定义配色与专注模式。

## 安装与启动

[GitHub 发布页](https://github.com/asoming/markwrite/releases)提供 Linux `.deb`、便携目录及通过 Windows CI 构建的 NSIS 安装程序（以实际发布资产为准）。

Linux 便携包解压到固定位置后：

```bash
./scripts/launch.sh
./scripts/install-desktop.sh
```

桌面入口可能需要首次右键“允许启动”。移动目录后重新运行安装脚本。`.deb` 安装后也可从应用菜单启动。

Windows 安装和构建见 [Windows 说明](docs/WINDOWS.md)。Windows 程序尚未代码签名；中文输入法、字体回退和缩放需要目标机器验证。

## 常用操作

| 操作 | 快捷键 |
| --- | --- |
| 新建 / 打开 / 保存 | Ctrl+N / Ctrl+O / Ctrl+S |
| 另存为 / 关闭标签 | Ctrl+Shift+S / Ctrl+W |
| 快速打开 / 命令面板 | Ctrl+P / Ctrl+K |
| 查找 / 替换 / 全文搜索 | Ctrl+F / Ctrl+H / Ctrl+Shift+F |
| 粗体 / 斜体 / 行内代码 | Ctrl+B / Ctrl+I / Ctrl+E |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z |
| 标题 1—3 / 段落移动 | Ctrl+Alt+1—3 / Alt+↑↓ |
| 设置 / 隐藏侧栏 / 退出专注 | Ctrl+, / Ctrl+\ / Esc |

## 开发和验证

Node.js 24、Rust stable。Ubuntu 22.04 / 24.04：

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
npm ci
npm run tauri dev
```

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build
# Windows 上：
npm run tauri -- build --config src-tauri/tauri.windows.conf.json --bundles nsis
```

浏览器预览 `npm run dev`，默认 http://127.0.0.1:1420。浏览器不提供本地历史、回收站和 Git；文件句柄需要重新选择，不能代替原生验收。

性能诊断（组件 / 热缓存基准，不等同于真机验收）：

```bash
MARKWRITE_BENCHMARK=1 npm test -- tests/editor-performance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml benchmark_workspace_search_100mb -- --ignored --nocapture
```

## 仍需明确的边界

- 真实 Fcitx5 / IBus / Windows 输入法候选词、Wayland、125%/150% 缩放、2 小时持续写作，以及冷启动 10 次测量尚需真机验收；当前不能标记 PRD v1.0 全部验收完成。
- 大于约 300KB 暂停即时渲染，大于 1MB 暂停 Markdown 语法解析；源码编辑仍保留全文。单文件上限 32MB。后台统计显示最近完成的结果。
- 搜索最多显示 500 条，目录扫描跳过隐藏目录、node_modules、target 与符号链接；附件清理采用保守引用判断，不猜测动态生成的路径。
- UTF-8（含 BOM）与既有 CRLF 保留；其他编码提示错误，不提供自动转换。YAML Front Matter 保留为源文，不做结构化表单。
- PDF 没有字形的字符、损坏图片和不支持的 HTML 会明确报错；完整 HTML 布局不保证在 Word/PDF 中等价，见导出说明。
- AI 需要用户提供服务地址和可用模型；不内置免费云端额度。界面支持与传输逻辑已实现，未使用真实付费模型验收。
- PRD 的 P2 仅列为候选的插件市场、云图床、发布服务和开放语法插件没有具体服务协议；本轮提供可执行的本地 Git、AI 适配与声明式编辑扩展，未实现任意代码插件或云服务。
- 不提供针对任意外部进程的完全互斥文件锁。改动源文、恢复副本与清理候选均由可见操作控制。

[PRD](docs/PRD.md) · [功能矩阵](docs/FEATURE_MATRIX.md) · [验证记录](docs/VALIDATION.md) · [图标说明](docs/icon-generation.md)

私有项目，尚未选择开源许可证。字体、依赖与图标的来源说明保留在仓库中。
