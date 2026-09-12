# Markwrite

**文件在原处，修改看得见。**

**Your files, with changes you can see.**

### [下载正式版 / Download for Linux & Windows](https://github.com/asoming/markwrite/releases/latest)

[中文功能介绍](README.zh-CN.md) · [English guide](README.en.md) · [发布记录 / Releases](https://github.com/asoming/markwrite/releases) · [反馈问题 / Issues](https://github.com/asoming/markwrite/issues)

Markwrite（墨页）是一款本地 Markdown 阅读与编辑工具。直接打开磁盘文件，在同一个应用中阅读、排版、比较文字修改，并用 Git 管理版本。无需导入知识库或注册账号。

Markwrite is a local Markdown reader and editor. Open files where they live, write and format text, compare revisions, and review Git changes in one application. No vault or account required.

![Markwrite：阅读与原生文件树 / Reading with the original file tree](screenshots/overview-zh-CN.png)

## 为技术文档整合的能力 / Built for technical documents

| 能力 / Capability | 实际用途 / What you can do |
| --- | --- |
| **Git 版本管理 / Git version control** | 查看文件状态与差异，选择文件提交，逐块解决三方冲突。 / Review changes, commit selected files, and resolve three-way conflicts. |
| **双文档与文字差异 / Dual documents and text differences** | 两边独立编辑、同步滚动；按行对齐并标出字级新增与删除。 / Edit both documents, link scrolling, and inspect aligned line and character changes. |
| **原文件优先 / Original files first** | 双击打开任意 Markdown；默认阅读，文件树跟随父目录。 / Open Markdown anywhere in reading mode, with its parent folder tree. |
| **可选择的 AI 助手 / Optional AI assistance** | 自带 API，测试连接，预览再接受修改；密钥可存系统凭据库。 / Bring your API, test connections, preview edits, and keep keys in the OS credential store. |
| **可携带的文档 / Portable documents** | 相对图片、内嵌图片、文档附件 ZIP，以及 HTML / PDF / DOCX 导出。 / Relative or embedded images, attachment ZIPs, and HTML / PDF / DOCX export. |

重点面向 README、技术方案、论文笔记和项目文档的本地审阅与版本管理。

Built around local review and version control for READMEs, technical plans, research notes, and project documentation.

![文字差异：逐行对齐，逐字查看修改 / Aligned text differences](screenshots/text-diff-zh-CN.png)

## 选择你的语言 / Choose your guide

- **[中文介绍](README.zh-CN.md)**：功能截图、安装、Git、对照、AI 接入与常见问题。
- **[English guide](README.en.md)**: screenshots, installation, Git, comparisons, AI setup, and limitations.

**平台 / Platforms:** Linux x86_64（Debian/Ubuntu `.deb`、便携包 / portable archive）；Windows 10/11 x64（安装程序 / installer）。

**核心离线 / Offline core:** 本地阅读、编辑、Git 和附件处理不需要云账号。AI、远程图片、发布与更新检查仅在你主动使用时联网。 / Local reading, editing, Git, and attachments need no cloud account. AI, remote images, publishing, and update checks connect only when requested.

**技术栈 / Stack:** Tauri 2 · React · TypeScript · Rust · CodeMirror 6.

**源码版本 / Source version:** 1.1.0。已发布安装包以[最新发布页](https://github.com/asoming/markwrite/releases/latest)为准。 / See the latest release page for available installers.
