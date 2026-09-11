# 墨页 · Markwrite

面向 Linux 和 Windows 的本地 Markdown 写作工具。使用 **Tauri 2 + React + TypeScript + Rust + CodeMirror 6**。

当前版本 **0.2.0 功能预览**。通过菜单排版、插入表格和公式，也可以直接编写 Markdown。已扩展文档管理、恢复、导出与可选服务连接；具体实现与验收状态见 [功能矩阵](docs/FEATURE_MATRIX.md)。Windows CI 正在验证，真实输入法和长期使用验收尚未完成。

<img src="public/assets/app-icon.png" width="100" alt="墨页应用图标" />

## 不记语法，也可以编辑

- 顶部「文件、编辑、段落、格式、插入、视图、主题、工具、帮助」菜单。
- 标题、粗体、斜体、删除线、代码、引用、列表、任务、缩进、段落移动均可点击完成。
- 链接表单、选择本地图片、可视化表格、对齐与 Excel/TSV 粘贴。
- 公式模板、中文步骤生成流程图；需要精细控制时仍可填写 LaTeX / Mermaid。
- 即时渲染、源码、阅读共用 Markdown 原文，格式操作可撤销。支持富文本转换粘贴与纯文本粘贴。

## 文件与文档管理

- 单文件、工作文件夹、文件树、多文档、最近文件、原生拖入和第二实例转交。记住最近 10 个工作文件夹，打开工作区后可直接切换。
- 创建、重命名、批量移到系统回收站；不会直接永久删除文档。
- 大纲与字数在 Web Worker 中计算，丢弃过期结果；可取消的全文搜索分批显示结果，原生目录监听同步文件变化。
- 文档并排对照、双链 `[[文档#标题|文字]]`、名称冲突选择、反向链接和标签检索。关联视图以当前文档为中心，区分入链、出链与互链；图中显示最多 20 篇邻居，完整清单可点击跳转，并提示断链和同名歧义。
- 自动保存、磁盘冲突比较、原子替换、历史浏览与可撤销恢复。
- 每篇文件保留最多 50 个历史版本，历史总空间上限 200MiB；这是本机恢复功能，不代替备份。
- 桌面草稿使用原生恢复文件，每 3 秒保底刷新，关闭前等待写入；不受浏览器 localStorage 小配额限制。保留一个前代恢复文件，单会话上限 256MiB。恢复机制仍需强制结束进程与长期使用的完整桌面验收。
- 新文档中的内嵌图片保存后迁移到 `assets/`；可设置一直内嵌。迁移失败保留内嵌原图，冲突暂停覆盖。
- 附件引用清单、未引用图片清理预览和回收站。网络图片只有用户点击加载后才请求。

## 输出与扩展

- 离线 HTML（可选目录、明暗主题）、PDF 和 Word DOCX；标准、学术、紧凑模板。
- PDF 自带中文字体，公式与图表使用静态 SVG；DOCX 包含 SVG 与兼容 PNG。具体排版边界见 [导出说明](docs/EXPORTS.md)。
- Git 状态、差异、初始化与选定文件本地提交，不自动推送，不执行仓库 hooks。
- AI：用户配置兼容 Chat Completions 的服务或本机模型，只发送明确选中的内容；先预览差异，再接受，支持撤销。密钥不持久化。
- 图床与 HTML 发布：连接用户配置的通用 HTTP 服务，支持 Bearer 密钥、图片表单字段与响应链接字段。图片上传成功后可插入链接；发布使用当前缓冲区生成的 HTML。每次明确点击才发送，密钥不持久化。接口要求见 [传输说明](docs/TRANSFER.md)。
- 编辑扩展：检查、导入、启停、导出和移除 JSON 文字片段与声明式行内语法。内置包提供 `==高亮==`、`%%重点%%`，也可按钮包裹选区；停用后保留原标记。规则不能执行脚本、读取文件或联网，见 [扩展说明](docs/EXTENSIONS.md)。
- 明暗主题、正文/代码字体、字号、行高、宽度、阅读预设、自定义配色与专注模式。

## 安装与启动

从 [GitHub 发布页](https://github.com/asoming/markwrite/releases) 下载已发布的 Linux `.deb` 或便携包，以页面中的实际资产为准。当前 Windows CI 进行中；NSIS 安装包只有在对应提交的构建与启动关闭检查成功后才计为已验证，下载方式见 [Windows 说明](docs/WINDOWS.md)。

Linux 便携包解压到固定位置后：

```bash
./scripts/launch.sh
./scripts/install-desktop.sh
```

桌面入口可能需要首次右键“允许启动”。移动目录后重新运行安装脚本。`.deb` 安装后也可从应用菜单启动。

Windows 目标为 Windows 10 / 11 x86_64，使用系统 WebView2。程序尚未代码签名；中文输入法、字体回退和缩放需要目标机器验证。

## 常用操作

| 操作                       | 快捷键                         |
| -------------------------- | ------------------------------ |
| 新建 / 打开 / 保存         | Ctrl+N / Ctrl+O / Ctrl+S       |
| 另存为 / 关闭标签          | Ctrl+Shift+S / Ctrl+W          |
| 快速打开 / 命令面板        | Ctrl+P / Ctrl+K                |
| 查找 / 替换 / 全文搜索     | Ctrl+F / Ctrl+H / Ctrl+Shift+F |
| 粗体 / 斜体 / 行内代码     | Ctrl+B / Ctrl+I / Ctrl+E       |
| 撤销 / 重做                | Ctrl+Z / Ctrl+Shift+Z          |
| 标题 1—3 / 段落移动        | Ctrl+Alt+1—3 / Alt+↑↓          |
| 设置 / 隐藏侧栏 / 退出专注 | Ctrl+, / Ctrl+\ / Esc          |

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

浏览器预览 `npm run dev`，默认 http://127.0.0.1:1420。浏览器不提供原生历史、回收站、Git、AI 或服务上传；文件句柄需要重新选择，不能代替桌面版验收。

性能诊断（组件 / 热缓存基准，不等同于真机验收）：

```bash
MARKWRITE_BENCHMARK=1 npm test -- tests/editor-performance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml benchmark_workspace_search_100mb -- --ignored --nocapture
```

## 仍需明确的边界

- 真实 Fcitx5 / IBus / Windows 输入法候选词、Wayland、125%/150% 缩放、2 小时持续写作，以及冷启动 10 次测量尚需真机验收；当前不能标记 PRD v1.0 全部验收完成。
- 正文超过 30 万 UTF-16 字符单位时暂停即时渲染，超过 100 万时暂停编辑器的 Markdown 语法解析；全文仍可编辑。这是字符阈值，不是文件字节数。原生单文件打开上限 32MiB，后台统计显示最近完成的结果。
- 搜索最多显示 500 条，目录扫描跳过隐藏目录、node_modules、target 与符号链接；附件清理采用保守引用判断，不猜测动态生成的路径。
- UTF-8（含 BOM）与既有 CRLF 保留；其他编码提示错误，不提供自动转换。YAML Front Matter 保留为源文，不做结构化表单。
- PDF 没有字形的字符、损坏图片和不支持的 HTML 会明确报错；完整 HTML 布局不保证在 Word/PDF 中等价，见导出说明。
- AI 需要用户提供服务地址和可用模型；不内置免费云端额度。界面支持与传输逻辑已实现，未使用真实付费模型验收。
- 图床与发布提供通用 HTTP 协议适配，需要配置兼容的服务；未验证特定商业平台，不自带存储、托管、账号、OAuth 或厂商签名适配。真实 AI、图床和发布服务仍需带可用配置联调。
- 扩展限于文字片段和声明式行内标记；没有任意代码插件或插件市场。关联视图限于当前文档的相邻关系，最近工作区是目录切换，不是跨工作区同步或全库图谱。
- 不提供针对任意外部进程的完全互斥文件锁。改动源文、恢复副本与清理候选均由可见操作控制。

[PRD](docs/PRD.md) · [功能矩阵](docs/FEATURE_MATRIX.md) · [验证记录](docs/VALIDATION.md) · [导出说明](docs/EXPORTS.md) · [图标说明](docs/icon-generation.md)

私有项目，尚未选择开源许可证。字体、依赖与图标的来源说明保留在仓库中。
