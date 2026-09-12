# [下载 / Download Markwrite — Linux & Windows](https://github.com/asoming/markwrite/releases/tag/v0.5.1)

**当前版本 / Current release: 0.5.1（预览版 / Preview）。** 发布页提供 Linux `.deb`、Linux 便携包及 Windows x64 安装程序。

Choose the Linux `.deb`, Linux portable archive, or Windows x64 installer from the release page above. Features, installation, and conversion limits are described below.

## 开发进度 / Development status — 2026-09-12

以下为 0.5.1 的实现和验收状态。功能可用与完整性能/平台验收分别记录，未完成项继续列出。
This is the implementation and acceptance status of 0.5.1. Feature availability and full performance/platform acceptance are tracked separately; outstanding work remains explicit.

| 工作项 / Work item | 当前状态 / Status |
| --- | --- |
| 阅读和 HTML 代码高亮 / Reader and HTML syntax highlighting | 已实现；Linux 原生和浏览器验证通过 / Implemented; native Linux and browser checks passed |
| 全目录快速打开 / Recursive quick open | 已实现；Linux 原生和浏览器验证通过 / Implemented; native Linux and browser checks passed |
| 窄窗口覆盖侧栏 / Narrow-window sidebar overlay | 已实现；真实浏览器交互与布局验证通过 / Implemented; real-browser interaction and layout checks passed |
| Git 冲突解释和标记解决 / Explain and resolve Git conflicts | 已实现；Linux 原生和浏览器验证通过 / Implemented; native Linux and browser checks passed |
| 性能与真实输入法 / Performance and real IME acceptance | 部分通过；正式包 IBus 两模式通过，1 秒目标仍未达 / Partial: production IBus checks pass in both modes; one-second target unmet |
| 文档一致性 / Documentation consistency | 已纠正旧描述，随验收更新 / Corrected; updated with validation |

仍未实现的后续增强：正文表格多格粘贴、行列拖动/排序，图片对齐/图注/重新链接，双编辑器与同步滚动，自定义快捷键，逐块/三方合并，批量文件操作中断自动恢复界面，GitHub 提示块和来源预设，可编辑 Office 公式。Typora CSS 主题为有边界的适配，不保证完整主题包原样还原。
Still pending: in-document table range paste/reordering/sorting; image alignment/captions/relinking; dual editors and synchronized scrolling; configurable shortcuts; hunk/three-way merge; interrupted multi-file operation recovery UI; GitHub alerts/source presets; editable Office equations. Imported Typora themes remain a bounded adaptation.

恢复历史版本先进入未保存编辑状态，后续保存时记录被替换的磁盘版本；恢复本身不立即生成新的历史条目，也不自动覆盖文件。
Restoring history creates an unsaved editor buffer. Saving later records the replaced disk version; restoration alone creates neither a history entry nor a source-file write.

## 0.5.1：高亮、快速打开、侧栏与 Git / Highlighting, quick open, sidebar and Git

- 阅读与 HTML 导出按语言高亮代码，语言解析按需在 Worker 加载；未知语言或超过 40,000 字符的单块保留纯文本，源代码内容不变。
- Ctrl+P 按需递归检索文件名，不读取正文；支持取消和中文子目录，最多返回 500 项。沿用隐藏目录、依赖目录、链接和 32 层深度的扫描边界。
- 正文可用宽度不足约 560px 时，侧栏改为浮层，支持 Esc、背景点击关闭与键盘焦点约束；宽窗口恢复原侧栏状态。
- Git 显示冲突原因，允许保存后标记已解决；完成合并时明确选择全部暂存项，支持保留删除或保留本地内容，不自动推送。冲突标记未清除、非 UTF-8 或超过 8MiB 的冲突文件仍需先处理；不会把编辑器里未保存的草稿误当作已解决。
- 修复 WebKitGTK 在即时编辑隐藏语法节点与中文输入交互时的渲染进程崩溃；组合输入期间保留文档装饰，提交后再恢复即时排版。

Reader and HTML code coloring loads language parsers on demand in a worker; unknown languages and blocks over 40,000 characters stay plain. Ctrl+P searches filenames recursively only when opened, with cancellation and 500 results. Narrow windows use a keyboard-accessible sidebar overlay. Git explains conflicts, stages explicitly resolved saved files, and completes reviewed merge commits without pushing. Live editing retains syntax text nodes and stable composition decorations to avoid a WebKitGTK IME/accessibility process crash. Non-UTF-8 or over-8MiB conflict files remain outside in-app resolution.

**[Linux / Windows CI 全部通过 / CI passed](https://github.com/asoming/markwrite/actions/runs/34677514192)。** 两平台各 941 项前端测试通过，Linux 81 项、Windows 73 项原生测试通过；各测试集合另有 2 项可选诊断/助手默认跳过。Windows 安装、中文空格路径文件关联、独立进程和恢复、源文件保持、卸载验证通过。
Both platforms passed 941 frontend tests; Linux passed 81 native tests and Windows passed 73, with two optional diagnostics/helpers skipped in each suite. Windows installation, quoted/Chinese filename associations, independent processes and recovery, unchanged source files, and removal passed.

**0.5.1 验收记录（2026-09-12）：**941 项前端测试、81 项 Linux 原生测试通过，另有 2 项可选前端诊断和 2 项原生助手/诊断未在默认集合执行。最终 deb 解包程序通过实际菜单/键盘验收：阅读 Worker 高亮、中文深层文件快速打开、Git 编辑保存→标记解决→双父合并提交、IBus libpinyin 在源码/即时编辑中的候选提交与撤销重做。浏览器验证窄窗口浮层、明暗高亮、查找和实际 HTML 下载；导出的代码保留原文与高亮样式。

**启动指标未达 1 秒。** 最终安装包打开 1MiB 文档的 10 个新进程样本（秒）：`3.552, 1.342, 1.332, 1.330, 1.355, 1.331, 1.357, 1.351, 1.342, 1.349`。中位数 1.346 秒，9/10 小于 3 秒，0/10 小于 1 秒。环境为 i9-14900HX、约 16GB 内存、WebKitGTK 2.50.4、私有 Xephyr 软件渲染；每次使用新应用配置，以 250ms AT-SPI 轮询计时到首屏标题可读，未清除操作系统文件缓存。此结果不是普通桌面的冷盘测试，也不等同于全部 PRD 性能验收通过。

**仍待验收：**真实输入到绘制 P95、两小时写作与内存趋势、完整冷启动/冷缓存搜索基准、Fcitx5、Windows 中文候选输入、Wayland、多屏与 125%/150% 缩放，以及 Word/WPS、公众号/飞书目标端与实际联网服务。保留后续增强清单，未用本次修复宣称完整 PRD 已完成。

**English acceptance record:** 941 frontend and 81 native Linux tests pass. The final deb executable passed actual keyboard/menu checks for worker coloring, recursive Chinese-path quick open, conflict resolution through a two-parent Git merge, and real IBus libpinyin input/undo/redo in both editor modes. Browser checks covered the narrow overlay, dark/light coloring, search and downloaded HTML. Ten fresh-process 1MiB samples ranged from 1.330 to 3.552 seconds (median 1.346); none met one second. Measurements used an i9-14900HX/16GB machine, WebKitGTK 2.50.4 and private Xephyr software rendering, with 250ms accessibility polling and no OS-cache clearing. Real input-to-paint P95, two-hour stability, cold-cache baselines, Fcitx5, Windows IME, Wayland, multi-monitor/DPI and destination/service interoperability still need acceptance.

# Markwrite

<img src="public/assets/app-icon.png" width="96" alt="Markwrite 应用图标" />

面向 Linux 和 Windows 的本地 Markdown 编辑与阅读工具，使用 **Tauri 2、React、TypeScript、Rust 和 CodeMirror 6**。文件保持为普通 Markdown，核心编辑、阅读、本地附件和导出可以离线使用，无需注册账号。你可以直接输入文字，再通过菜单选择标题、粗体、列表、表格、图片和公式；熟悉 Markdown 时也可以随时编辑源码。

Markwrite is a local Markdown editor and reader for **Linux and Windows**, built with **Tauri 2, React, TypeScript, Rust, and CodeMirror 6**. Your documents remain ordinary Markdown files. Write and format text through menus, use live Markdown editing, or switch to source mode whenever you need precise control. Core editing, reading, local attachments, and export work offline without an account.

侧栏品牌显示为 **墨页 Markwrite**；窗口、安装程序、桌面快捷方式及其他应用名称统一使用 **Markwrite**。界面可在简体中文和 English 之间切换。

The sidebar displays the bilingual brand; the application, installer, and desktop shortcut use **Markwrite**. Both Simplified Chinese and English interfaces are available.

## 从这里开始 / Quick start

**中文**

1. **打开或新建。** 在「文件」选择「打开文档…」「打开文件夹…」或「新建文档」。打开文档默认进入阅读模式；要修改内容，将鼠标移到正文右下角、状态栏上方，在浮动工具条选择「编辑」，或选择「视图 → 即时渲染编辑」。
2. **排版。** 选中文字，在「格式」选择粗体、斜体或删除线；把光标放在某段，在「段落」选择标题、正文、引用或列表。
3. **保存。** 按 `Ctrl+S`。新草稿先选择保存位置和 `.md` 文件名；明确进入编辑后，已有路径的文档默认自动保存；阅读模式保留草稿而不写入原文件。底部状态栏会显示保存结果，失败或冲突会提供处理入口。
4. **输出。** 在「文件」选择导出 HTML、PDF 或 Word 文档，选择模板后点击「选择位置并导出」。导出读取当前编辑内容，无需先覆盖原文件。
5. **设置。** 按 `Ctrl+,`，或选择「主题 → 排版与主题设置…」。左侧选择分类，右侧修改选项；设置保存在本机。

**English**

1. **Open or create a document** from **File**. Documents open in reading mode by default. Hover above the status bar at the bottom right to reveal the mode controls, or use **View** to switch to editing or Markdown source.
2. **Format your text** with **Format**, **Paragraph**, and **Insert**: headings, emphasis, lists, tables, links, images, math, and diagrams are available through menus.
3. **Save with `Ctrl+S`**. Choose a location for a new draft; autosave applies to documents you have explicitly opened for editing. Reading mode retains drafts without writing to the source. Check the status bar for save results and conflict prompts.
4. **Import or export** from **File**. Import TXT, HTML, or DOCX into a new Markdown draft; export the current document to HTML, PDF, or DOCX without first overwriting the source file.
5. **Open Settings with `Ctrl+,`**. Choose **General** to change the interface language and **Appearance** to adjust the theme and floating controls. Preferences stay on your computer.

## 功能概览 / Features at a glance

| 功能 / Feature                    | 说明 / What it does                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 编辑与阅读 / Editing and reading  | 同一正文可在即时渲染、源码与阅读模式切换。 / Switch between live editing, Markdown source, and reading without creating separate copies.       |
| 文件树 / File tree                | 跟随当前 Markdown 的父目录，也可固定文件夹。 / Browse the current document’s parent folder or pin a workspace folder.                          |
| 排版与专注 / Typography and focus | 五种文档主题、自定义字体与颜色、浮动专注按钮。 / Five document themes, custom fonts and colors, and a floating focus control.                  |
| 保存与恢复 / Saving and recovery  | 自动保存、外部修改冲突提示、草稿恢复与本地版本历史。 / Autosave, external-change conflict handling, draft recovery, and local version history. |
| 文档工具 / Document tools         | 大纲、全文搜索、内部链接、反向链接、标签与附件管理。 / Outline, full-text search, internal links, backlinks, tags, and attachment management.  |
| 格式转换 / Conversion             | 导入 TXT/HTML/DOCX；导出 HTML/PDF/DOCX。 / Import TXT, HTML, and DOCX; export HTML, PDF, and DOCX.                                             |

**English: conversion and service limits.** Complex HTML and Word layouts may lose formatting during import. Exported math and diagrams in DOCX are graphics, not editable Office objects. PDF supports A4, A5, and Letter pagination with font/character limits. Review conversion messages and the exported result.

The native single-file limit is 32 MiB, and live Markdown rendering is reduced for very large documents. There is no real-time collaboration, mobile app, or cloud synchronization. The browser preview has fewer filesystem capabilities than the desktop application.

Git integration requires a local Git installation. AI assistance, image upload, and HTML publishing are optional connections to services you configure; no cloud account, hosting, or API credits are included.

## 0.5：原生文件与轻量阅读 / Native files and focused reading

- **直接读原文件。** 双击磁盘任意位置的 `.md`，或用「打开文档」选择文件。无需导入库、注册或复制到工作区；父目录文件树按需逐层读取。编辑器、图谱、标签与反向链接不会参与普通阅读的启动。指定文件先显示，旧会话随后恢复，未保存草稿单独保留。
- **真正的阅读模式。** 阅读时不挂载编辑器，不改任务复选框，不自动保存恢复出的未保存内容。返回阅读会暂停该文档自动保存，文字与撤销记录保留；需要修改时一键进入编辑或源码。保存前仍检查磁盘版本，独立进程之间也会检测冲突。
- **阅读查找与导航。** `Ctrl+F` 在阅读页高亮、计数；`F3` / `Shift+F3` 前后查找。记录每个本地文件的阅读位置，可收藏段落。`Alt+←/→` 后退、前进，`Alt+↑/↓` 打开同目录上一篇、下一篇。入口也在「视图」。
- **统一 Markdown 渲染。** CommonMark 0.31.2 基础模式用官方全部 **652 个示例逐字验证**。默认叠加明确的 GFM 表格、任务列表、删除线、脚注、KaTeX 与 Mermaid；阅读和输出共享解析器。Wiki 链接和自定义行内标记默认关闭，可在「设置 → 编辑器」单独启用兼容，不改源文件。
- **独立进程窗口。** `Ctrl+Shift+N` 新建独立窗口；「文件 → 当前文件在独立窗口打开」用于并排查看。每个窗口有独立的进程、恢复目录和 WebView 数据；一个窗口被终止不需要退出其他窗口。「恢复独立窗口」可找回已保存的窗口草稿。打开当前文件的磁盘版本不会搬走当前未保存的缓冲区。
- **中文路径、编码与附件。** 图片按原相对路径读取，支持中文、空格及授权范围内的 `../`。保存不会迁移既有图片。读不到附件时可以选择其所在文件夹授权。「文件 → 选择编码重新打开」可只读预览 UTF-8、UTF-16 LE/BE、GBK、GB18030；采用后按所选编码保存，无法编码的字符会阻止保存。
- **长文按需渲染。** 文档在 Worker 中解析，可见区域以外的块卸载，图片和 Mermaid 在接近视口时加载。引用定义、脚注、代码围栏与 HTML 容器保持完整；表格和列表沿完整行/条目分批。搜索与定位覆盖整篇，不能把未挂载段落当作不存在。
- **便携与复制。** 「文档与附件打包 ZIP」只打包当前文章和所引用本地文件，预览缺失、远程或未授权资源；只改包内引用，原文件与附件不变。「复制到公众号 / 飞书」生成内联样式的 HTML 和纯文本，公式与流程图在本机转为 PNG，无上传。

**English**

- Open original files anywhere on disk, with no vault, import, relocation or account. The parent tree loads one level at a time. Reading does not load the editor or build a workspace index. Explicitly requested files display before session restoration; recovered drafts remain available separately.
- Reading does not edit task items or autosave recovered changes. Switching back to reading pauses that document's autosave while preserving the draft and undo history. Deliberate editing and explicit close/save choices control writes, with disk-version checks across processes.
- Find, count and navigate matches in reading mode with `Ctrl+F`, `F3` and `Shift+F3`. Keep paragraph bookmarks and per-file reading positions; use `Alt+Left/Right` for history and `Alt+Up/Down` for adjacent files in the same folder.
- All **652 official CommonMark 0.31.2 examples** verify the base parser byte for byte. Explicit GFM tables, tasks, strikethrough, footnotes, KaTeX and Mermaid are enabled for documents. Wiki links and custom inline markers require the optional legacy-compatibility setting. Original Markdown remains unchanged.
- `Ctrl+Shift+N` creates an independent process window. Open the current disk file in another window or restore a previous independent window from **File**. Recovery and WebView data are isolated; source-file writes still use cross-process locks and version checks.
- Existing images load in place, including Chinese names, spaces and authorized parent-relative paths. Saving does not migrate attachments. Preview UTF-8, UTF-16 LE/BE, GBK or GB18030 without writing; adopted encodings are retained on save, with fatal conversion errors instead of replacement characters.
- Worker parsing and a windowed block view keep long documents out of the DOM until needed. Images and diagrams are lazy; references, footnotes, fenced code and HTML containers remain intact.
- Export one document and referenced local attachments as ZIP. Review missing, remote and denied assets before exporting; only the copy inside the archive is rewritten. WeChat/Feishu clipboard presets include HTML and plain text with local image conversion and no uploads.

**输出边界 / Output limits:** 公众号、飞书等目标编辑器可能过滤内嵌图片或部分样式；这里验证的是离线生成与剪贴板格式，并未代替目标平台粘贴测试。PDF 使用随包字体，脚注回链显示为 `[back]`，行内公式与相邻可选择文字保持同行；复杂大公式可能需要独立段落。ZIP 默认不包含未引用文件、整库、应用配置或历史；最多 2,000 处引用、500 个去重附件、单附件 32MiB、总附件 128MiB。网络资源不自动下载，跳过项列入包内清单。

Destination editors may strip data images or some inline styles; offline clipboard verification does not guarantee identical rendering after a platform paste. PDF uses bundled fonts and `[back]` for footnote return links; inline math stays with selectable neighboring text, while very large formulas may need a display block. ZIP limits are 2,000 references, 500 unique assets, 32MiB per asset and 128MiB total attachments; unrelated files, workspace settings and history are excluded. Remote resources are never downloaded automatically, and skipped entries are recorded in the manifest.

工作区批量索引与引用改写目前要求 UTF-8；其他编码可单篇阅读、编辑与保存，批量操作会拒绝无法安全解码的文件。ZIP 收集当前文章直接引用的文件；引用另一个 Markdown 时，不继续递归收集那篇文章的附件。

Workspace indexing and batch reference rewriting currently require UTF-8; other encodings support individual reading, editing and saving, while unsafe batch decoding is rejected. ZIP collects direct references from the current article; linked Markdown files do not trigger recursive attachment collection.

## 0.4 新增功能 / What's new in 0.4

- **面板响应：**反向链接、标签和关联视图共用后台 Worker 索引；切换面板复用文件快照，编辑只重新解析改变的文档。标签默认折叠，大量结果分批显示，减少阻塞。
- **直接编辑：**即时渲染中点击表格单元格输入，支持 Tab 切换、Enter/Escape 结束和撤销。选择独立成段的图片可输入宽高、保持比例、拖动缩放或打开预览；设置尺寸后使用带宽高的 HTML `<img>` 保存在 Markdown 中。
- **主题导入：**「设置 → 外观」导入 `.css`，支持主题库切换、重命名、导出和移除。适配 Typora 常见正文选择器；只作用于正文，源码和设置保留原样。外部资源、相对字体文件、页面定位等不支持的规则会过滤并提示；带配套字体目录的主题可能需要自行安装字体，不能保证所有主题完全一致。
- **独立备份：**「设置 → 文件」选择备份目录，手动备份或启用按小时间隔备份。快照包含当前工作文件夹中已保存的 Markdown、支持的图片、应用设置、自定义主题和声明式扩展，不包含未保存草稿及密钥字段。自动备份仅在应用运行时执行，重新启动后补执行已到期的计划。恢复前显示摘要、校验文件，恢复到新的 `Markwrite-restored-*` 文件夹，可选择是否恢复设置。没有云端上传。
- **应用更新：**「设置 → 通用」检查 GitHub 发布，选择是否包含预览版本，下载当前系统安装包并校验 SHA-256。保存工作、退出应用后手动安装。私有仓库可输入有该仓库 Contents 读取权限的令牌，或使用已登录的浏览器发布页；令牌只在当前面板内存中使用，不写入设置和备份。
- **改名与移动：**「文件 → 重命名 / 移动到…」以及文件管理中的改名，会预览当前工作文件夹和已打开文档的引用变化。选择要更新的文档后保存（包含其未保存编辑），并检查磁盘版本。支持常见相对链接、图片、Wiki 链接与目录移动；同名歧义保留并提示。未勾选引用、其他工作区和无法确认的语法需自行维护。跨文件系统移动不支持，会报错并保留原文件。
- **导出排版：**PDF/DOCX 可选 A4、A5、Letter、12–40mm 页边距、页眉页脚、页码、封面与目录。PDF 面板显示实际生成文件的分页预览，支持保存同一份 PDF 后用系统阅读器打印。PDF 目录有实际页码；DOCX 目录为可点击的标题列表，不承诺与 Word/WPS 重排后的页码一致。

**English**

- **Responsive document tools:** backlinks, tags, and the related-document view share a worker index and cached workspace reads. Only changed documents are reparsed; tag contents are collapsed and long lists load in batches.
- **Direct editing:** edit table cells in place, navigate with Tab, and undo changes. Resize standalone images with width/height controls or a drag handle, preserve aspect ratio, and preview images. Explicit dimensions are stored as HTML `<img>` attributes in the Markdown file.
- **Imported CSS themes:** manage document themes in **Settings → Appearance**. Common Typora selectors are adapted and scoped to the document. Unsupported layout rules and external/relative resources are filtered with notices; arbitrary themes are not guaranteed to match Typora exactly.
- **Independent backups:** choose a destination in **Settings → Files**, then back up manually or on an hourly interval. Snapshots include saved workspace Markdown and supported images, preferences, imported themes, and declarative extensions. Unsaved drafts and secret fields are excluded. Scheduling runs while the app is open and catches up after restart. Restore verifies the snapshot into a new folder and optionally restores preferences. Files are not uploaded.
- **Application updates:** **Settings → General** checks GitHub, downloads the platform installer, and verifies SHA-256. Save your work, quit, and install manually. A private repository needs a repository Contents read token or a signed-in browser. Tokens remain in the current panel's memory only.
- **Reference-aware rename/move:** review affected links and select the documents to save, including unsaved edits. Disk version checks prevent applying a stale preview. Relative document/image links, common Wiki links, and moved directories are supported within the current workspace and open documents. Ambiguous references are left for manual review. Cross-filesystem moves are rejected without deleting the original.
- **Export layout:** A4/A5/Letter paper, 12–40mm margins, headers, footers, page numbers, a cover, and a table of contents for PDF/DOCX. The PDF preview shows the generated pages; save that PDF to print with a system reader. PDF contents include page numbers; DOCX contents link to headings without promising page numbers after Office reflow.

## 界面与日常使用 / Interface and daily use

### 界面与文件树

正文上方保留一行菜单，模式切换和专注按钮移到**正文右下角、状态栏上方**。鼠标移入该区域时显示浮动工具条，移开后隐藏；键盘 Tab 聚焦时也会显示，触屏直接显示工具条。工具条可切换「阅读、编辑、源码」，并进入或退出专注模式；「视图」菜单仍提供这些操作。在「设置 → 外观」可调整工具条的透明度（0–80%）。

The floating controls sit **at the bottom right, just above the status bar**. Hover to reveal reading, editing, source, and focus controls; they hide when the pointer leaves. Keyboard focus also reveals them, and touch devices keep the controls visible. Adjust the toolbar transparency from **0–80%** in **Settings → Appearance**. The **View** menu remains available for these actions.

当前文件名显示在系统窗口标题中；同时打开多篇文档时显示标签栏，用于切换和关闭文档。只打开一篇文档时不占用额外的标签栏空间。

左侧文件树默认**跟随当前 Markdown 所在的父文件夹**。打开磁盘文档或切换到另一个目录中的文档后，文件树随之更新，可直接打开相邻文件；读取失败时显示重试入口，也可手动选择文件夹。

- **固定目录：**手动使用「打开文件夹」后自动固定该目录，切换文档时文件树保持原目录。
- **恢复跟随：**点击文件树标题旁的图钉，或在「设置 → 文件 → 跟随当前文件」切换。图钉也可将当前跟随的目录固定下来。
- **展开目录：**子文件夹默认折叠，当前文档所在的祖先目录默认展开；筛选作用于已读取层级，不会因此遍历整个项目。跨目录内容搜索使用「文件夹全文搜索」。也可点击文件夹手动展开或收起。
- **草稿与最近文件：**尚未保存到磁盘的文档集中在文件树下方的「草稿」区域；「最近打开」默认折叠，点击后展开。

### 分类设置、语言与默认阅读

设置采用左右布局，窄窗口会调整导航，常用选项集中在五个分类：

| 分类   | 可设置内容                                                                          |
| ------ | ----------------------------------------------------------------------------------- |
| 文件   | 文件树跟随当前文件、自动保存、默认打开方式、独立备份和恢复；查看搜索排除规则        |
| 编辑器 | 默认打开模式、字号、行高、正文宽度、衬线/无衬线、自定义正文和代码字体、阅读排版预设 |
| 图像   | 保存到文档旁的 `assets` 文件夹，或内嵌到 Markdown                                   |
| 外观   | 内置和导入主题、自定义背景/正文/强调色、恢复主题原色、浮动工具条透明度              |
| 通用   | 简体中文或 English 界面、应用更新、恢复默认设置                                     |

默认打开模式为**阅读**，也可改为即时渲染编辑或 Markdown 源码。当前文档仍可通过右下角浮动工具条或「视图」随时切换。切换界面语言不翻译或修改文档内容。旧设置会补齐新增字段，保留已有排版和保存偏好。

### 主题

保留浅色、深色、跟随系统，并提供以下五种文档主题。菜单「主题」和设置「外观」均可选择。0.3.1 为阅读和即时渲染编辑分别适配字体、标题比例、段落间距、表格、引用和代码块。

| 主题      | 字体与排版                                                |
| --------- | --------------------------------------------------------- |
| Github    | Open Sans 无衬线正文，白底、标题分隔线和蓝色链接          |
| Newsprint | PT Serif 衬线正文，纸张底色、较窄正文和宽松段落间距       |
| Night     | 系统无衬线字体，石墨灰底色、紧凑标题和浅青色链接          |
| Pixyll    | Merriweather 衬线正文、Lato 大标题，较大字号与充足行间距  |
| Whitey    | Vollkorn 衬线正文，居中的一至三级标题、细线装饰与蓝色链接 |

这些主题根据参考主题的排版特点适配 Markwrite：Pixyll 的排版实现衍生自 MIT 授权版本，Github、Newsprint、Night、Whitey 的样式为独立实现。它们适用于本应用的阅读器与 CodeMirror 编辑器，并非直接加载或完整复刻 Typora 原版 CSS。来源、版本与许可说明见 [主题 NOTICE](public/themes/NOTICE.txt)。

选择主题会应用该主题的默认颜色、字号、行高、正文宽度与衬线风格，之后仍可自行调整。自定义正文和代码字体名称会保留并优先使用，须已在本机安装。主题所需的 Open Sans、PT Serif、Merriweather、Lato 与 Vollkorn 字体随应用提供，可离线加载；中文等未覆盖字符使用系统字体回退，因此不同系统的细节可能有所差异。

### 导入 TXT、HTML 和 DOCX

通过「文件 → 导入文件…」选择来源文件，转换结果作为**新的 Markdown 草稿**打开。导入不会覆盖或修改来源文件；检查结果后按 `Ctrl+S` 另行保存。

| 格式       | 转换行为                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------- |
| TXT        | 支持 UTF-8，以及带 BOM 的 UTF-16 LE/BE；按普通文字导入，转义容易被误认为 Markdown 的符号  |
| HTML / HTM | 转换标题、段落、列表、链接、基础表格和图片；净化脚本、事件与活动内容，不保留网页 CSS 布局 |
| DOCX       | 提取文字、标题、列表、基础表格和可转换图片，生成 Markdown；不加载外部文件或执行文档内容   |

HTML 的本地相对图片在授权来源目录内尝试内嵌；无法读取的图片会提示，网络图片保留引用，仍需主动点击加载。复杂 Word 版式、文本框、浮动对象、页眉页脚、分页、合并表格和 Office 公式等可能转换有损，请查看转换提示并检查草稿。导入不是原版式复刻，也不支持旧 `.doc`、PDF 或加密 DOCX。

单文件及转换后的 Markdown 上限为 32MiB；桌面文件选择器每批最多 16 个文件、合计 64MiB。DOCX 还检查压缩包结构与展开大小，损坏或不支持的文件会被拒绝。普通 Markdown 直接打开默认使用 UTF-8；其他编码通过「选择编码重新打开」预览并采用，编码转换不会在浏览时自动发生。

### 设置默认打开方式

在「设置 → 文件 → 默认打开方式」点击「设为默认应用」。也可点击「刷新状态」重新读取系统的实际关联；刷新本身不会更改默认应用。

- **Linux：**复用有效的 Markwrite 桌面入口，必要时创建用户入口。优先通过 GIO 设置和查询 `text/markdown` 与其旧类型名 `text/x-markdown`；缺少 GIO 工具时退回 `xdg-mime`。Ubuntu 的 GIO 命令由 `libglib2.0-bin` 提供。用户已有的当前桌面专用配置若覆盖通用设置，只更新其中已有的 Markdown 默认项，并保留修改前副本；不改变 TXT、HTML、DOCX 的默认应用。
- **Windows：**注册 Markwrite 为可选应用，再打开系统「默认应用」设置。需要在那里为 `.md`、`.markdown` 选择 Markwrite，返回后点击「刷新状态」；打开系统设置本身不等于关联已经完成。

0.3.1 修复了 Ubuntu 22.04 / GNOME 上“已经设为默认，却提示尚未确认”的误报：旧版 `xdg-mime` 无法正确识别带引号的启动路径，而 GNOME 使用的 GIO 已确认关联成功。更新后可刷新状态查看结果；这一排查结论不代表所有 Linux 桌面环境都已验收。

便携目录移动后请重新生成入口或重新设置关联，避免旧入口继续指向原位置。

## 编辑与阅读

顶部单行菜单提供「文件、编辑、段落、格式、插入、视图、主题、工具、帮助」，常用操作不依赖记忆语法或快捷键。右下角浮动工具条集中提供模式切换和专注按钮。

- **三种模式：**即时渲染编辑、完整 Markdown 源码和只读阅读共用同一份正文。切换模式保留编辑会话和撤销历史；阅读模式支持选择复制、标题跳转和链接浏览。
- **基本格式：**一级至六级标题、粗体、斜体、删除线、行内代码、代码块、引用、有序/无序列表、待办、分隔线、缩进和段落上下移动。
- **查找与粘贴：**文内查找替换、全部替换、富文本转换粘贴与纯文本粘贴。任务勾选、局部格式和表格修改写回 Markdown，可撤销。
- **表格：**在「插入 → 表格 / 编辑当前表格…」填写网格，增删行列、设置列对齐，支持从 Excel/TSV 粘贴。修改已有表格时将光标放回表格，打开同一菜单后点击「更新表格」。
- **图片与链接：**链接表单支持网址和文档；图片可以选择文件、拖入或从剪贴板粘贴。
- **公式：**「插入 → 数学公式…」提供质能方程、勾股定理、求根公式、分数、求和、积分模板，可选择行内显示，也可直接填写 LaTeX。
- **流程图：**「插入 → 流程图…」按每行一个中文步骤生成流程；复杂分支可以使用 Mermaid 源码，渲染错误在内容处提示。
- **阅读布局：**可收起侧栏、开启专注模式、并排对照文档，选择日常写作、长文阅读或技术文档排版预设。

支持常见 Markdown、GFM 表格和任务列表、围栏代码高亮、数学公式及 Mermaid。代码不会执行。YAML Front Matter 和未知语法保留源码；不声称兼容任意 Markdown 方言或任意 HTML 页面。

## 文件、搜索与文档关联

- 文件树默认跟随当前 Markdown 的父目录，也可手动打开文件夹并固定；支持多文档标签、独立草稿区域、折叠的最近文件列表、中文与空格路径、原生拖入、第二次启动时向已有窗口转交文件。
- 创建文档/文件夹、重命名、批量移到系统回收站。未保存修改会阻止相关删除；重命名和移动会预览受影响的引用，确认后保存所选文档。
- 切换文件夹会更换当前文件树和搜索范围；不提供跨工作区同步或聚合搜索。
- 文件名筛选与全文搜索分开。全文搜索返回文件、行号和片段，优先考虑打开文档的未保存内容，结果分批显示，可取消；过期任务不能覆盖新查询。
- 原生目录监听用于发现外部变化；大纲和字数由 Web Worker 计算，丢弃过期响应，等待期间显示最近完成的结果。
- 支持 `[[文档]]`、`[[文档#标题|显示文字]]`、反向链接和 `#标签` 检索。名称冲突时选择目标，断链给出提示，代码内容不参与链接/标签索引。
- 关联视图以当前文档为中心，区分入链、出链和互链。图中最多显示 20 个相邻文档，完整列表可点击或用键盘打开，并提示重复引用、断链与同名歧义。

扫描仅针对手动选择的工作目录，或跟随已打开 Markdown 所获得的父目录，排除隐藏目录、`.git`、`node_modules`、`target` 和符号链接；全文搜索最多显示 500 条匹配。浏览器预览仍受文件选择器授权限制，无法自动取得父目录时需要手动打开文件夹。

## 保存、恢复与附件

独立备份仅包括当前工作目录中的 Markdown 和支持的图片，单文件最多 32MiB、快照最多 1GiB、最多 10,000 个文件；排除隐藏目录、`node_modules`、`target` 和符号链接。不包含未保存草稿、目录外附件或历史记录，不会自动清理旧快照。

Independent backups include workspace Markdown and supported images, up to 32MiB per file, 1GiB per snapshot, and 10,000 files. Hidden folders, `node_modules`, `target`, and symlinks are excluded. Unsaved drafts, external attachments, and version history are not included; old snapshots are not automatically deleted.

引用批量更新在普通错误时会尝试回退，并保留恢复副本；多文件写入与移动不构成断电原子事务。崩溃或断电可能留下部分完成状态，原始副本记录在应用数据目录 `recovery/reference-transaction-*` 中，需要手动检查和恢复，尚无启动时自动重放。

Reference updates attempt rollback on ordinary errors and retain recovery copies. Multiple file writes and a move are not power-loss atomic: interruption can leave a partially completed operation. Original copies in the app data directory under `recovery/reference-transaction-*` require manual review and recovery; startup does not automatically replay these transactions.

### 保存和冲突

明确进入编辑的已有路径文档默认在停止输入后自动保存，也可关闭自动保存并使用 `Ctrl+S`。阅读模式及尚未主动进入编辑的恢复草稿不会自动保存。保存使用临时文件与原子替换；写入前检查磁盘版本，外部修改或删除会触发冲突保护。

冲突时可以比较差异、采用磁盘内容、另存副本，或明确选择保存当前版本。写入失败不会显示为已保存。UTF-8 BOM 和已有 CRLF 换行保留；非 UTF-8 Markdown 不会被静默解码后覆盖。

### 草稿恢复和版本历史

桌面版使用原生恢复文件，每 3 秒保底刷新，正常退出等待恢复数据写入；保存一个前代恢复文件。单会话上限 256MiB。未命名草稿、修改内容与内嵌图片不依赖浏览器 localStorage 的小配额。

在「视图 → 版本历史」选择时间，查看差异，再点击「恢复到编辑器（可撤销）」。恢复后继续编辑或保存；保存会保留被替换版本。每篇文档最多保留 50 个历史版本，历史总空间上限 200MiB。恢复与历史都是本机功能，不替代独立备份，也不提供与任意外部程序之间的完全互斥文件锁。

### 图片与附件

新增图片默认存到文档旁的 `assets/`，以相对路径引用；可改为内嵌 Markdown。新草稿中的图片先内嵌，首次保存也保留内嵌形式。保存与设置变化不会自动搬动既有附件；只有主动插入的新图片使用当前保存策略。

附件面板显示引用和未引用候选。清理前预览并确认，重新检查磁盘及当前缓冲区的引用后移到系统回收站；不会直接永久删除。网络图片默认不请求，点击加载后才访问远端。缺失图片展示路径或提示。

## 导出 HTML、PDF 与 DOCX

在「文件」选择导出格式。三种格式都读取当前编辑缓冲区，提供「标准文档」「学术阅读」「紧凑笔记」模板；导出不会先覆盖 Markdown 源文。桌面版由系统对话框选择位置，取消不生成文件。

| 格式 | 输出内容                                                                                    |
| ---- | ------------------------------------------------------------------------------------------- |
| HTML | UTF-8 单文件页面，可选目录及浅色/深色；内嵌本地图片、公式资源与静态图表，支持离线查看       |
| PDF  | 本地生成 A4/A5/Letter 分页文件和真实页面预览；可选择的文字、页码及封面目录；内置中文字体    |
| DOCX | 真实 OOXML 文档，标题、段落、表格、链接和文字格式可继续编辑；公式与图表含 SVG 和 PNG 后备图 |

### 实际排版边界

- PDF 行内公式与相邻文字保持同行；图片和过宽公式可独立成段。DOCX 支持将公式图形放在段落内。
- DOCX 中的公式和流程图是图形，不是可继续编辑的 Office 数学公式或流程图对象。
- PDF 中文字体提供常规和粗体，没有独立斜体字形；DOCX 保留斜体属性，由阅读器显示。
- DOCX 正文不内嵌完整中文字体，目标系统的字体回退可能影响分页。Word、WPS、LibreOffice 的显示效果可能不同。
- 任意网页 CSS 布局、合并单元格和活动内容不属于 PDF/DOCX 转换范围。代码保留文字、缩进与换行，不保证与编辑器配色相同。
- 缺失图片、错误公式、未完成的图表、合并单元格，以及 PDF 字库未覆盖的字符会阻止导出并显示原因。部分 Emoji 需要改用 DOCX/HTML 或替换字符。

已在 Linux 真实浏览器中生成含中文、公式、Mermaid、表格与图片的 PDF/DOCX；PDF 经文本提取和页面检查，DOCX 经 LibreOffice 7.3 转成两页 PDF 后逐页检查。该结果不能替代 Windows 原生保存流程或不同 Word/WPS 版本的验收。

## 可选高级功能

### Git

「工具 → Git 版本管理」支持仓库初始化、当前状态、差异和选择文件本地提交。需要本机安装 Git 并配置提交身份。提交仅包含所选文件，保留其他已暂存改动，不执行仓库 hooks；不自动推送，不自动解决合并冲突。

### AI 写作助手

先选中需要处理的文字，再打开「工具 → AI 写作助手」，填写兼容 Chat Completions 的完整 API 地址、模型和可选密钥。支持远程 HTTPS 服务及本机 HTTP 模型。

只有点击「发送并预览修改」才发送选区和操作说明，不自动上传全文。返回内容先显示差异，接受后可撤销；原文发生变化时会阻止直接套用旧结果。密钥仅留在当前面板的内存中，不持久化。需要自行提供可用服务和额度；“停止等待”不保证服务端取消已收到的请求。

### 图床与 HTML 发布

「工具」提供图片上传和当前文档发布，使用用户配置的通用 HTTP 服务。程序不自带图床、托管空间或账号，也不内置厂商签名、OAuth 或专用 SDK 适配。

| 操作           | 请求协议                                                                                                       | 发送内容                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 上传图片到图床 | `multipart/form-data` POST；文件字段默认 `file`，可配置                                                        | 所选 PNG/JPEG/GIF/WebP/AVIF 图片，最多 20MiB；成功后可插入返回链接 |
| 发布当前文档   | `Content-Type: text/html; charset=utf-8` POST；文件名提示放在 `X-Markwrite-Filename` 头，使用 UTF-8 百分号编码 | 当前缓冲区生成的 HTML，含已嵌入资源，最多 32MiB                    |

远程地址必须 HTTPS，本机可用 localhost、127.0.0.1 或 `[::1]` HTTP。可选密钥通过 Bearer 头发送。默认读取响应 JSON 的 `url`，可配置 `data.url` 等点分路径；也支持 `Location` 头，最终链接必须为 HTTP(S)。请求不自动跟随重定向或重试。

例如成功响应可以是 `{"url":"https://example.com/result"}`。界面展示发送目标和范围，每次明确点击后才发起请求；密钥不持久化，返回链接不会自动打开。尚未完成对特定商业服务的真实联调。超时不表示服务端没收到内容，重试前请检查服务端结果。

### 声明式编辑扩展

「工具 → 编辑扩展」支持检查、预览、导入、启用/停用、导出和移除 JSON 扩展包。内置“日常写作”提供模板片段、`==高亮==` 与 `%%重点%%`，也可以通过按钮包裹当前选区。

扩展包可以包含 `snippets` 和 `inlineSyntax`。文字片段的 `{{selection}}` 替换成选区；行内规则定义名称、开始标记、结束标记和六位 HEX 背景色。例如：

```json
{
  "version": 1,
  "name": "我的标记",
  "enabled": true,
  "snippets": [],
  "inlineSyntax": [{ "name": "高亮", "open": "==", "close": "==", "color": "#fff0a6" }]
}
```

规则不跨行、不递归解析内部 Markdown，代码块和行内代码保持字面内容。停用规则后显示原始标记，不删除正文。标准保留标记不能覆盖，冲突和超限规则会被拒绝。当前没有任意代码插件或插件市场；规则不能执行脚本、读取文件、联网或注入自定义 CSS。

## 安装与启动 / Installation

安装包和版本说明统一在 **[GitHub Releases](https://github.com/asoming/markwrite/releases)**。请下载适合自己系统的安装包；源代码压缩包不包含已编译的桌面程序。

Download an installer or portable package from **[GitHub Releases](https://github.com/asoming/markwrite/releases)**. Source-code archives do not include a compiled desktop application.

### Linux

目标构建为 x86_64，开发与检查主要在 Ubuntu 22.04 / GNOME / X11 完成。

**English:** On Debian/Ubuntu x86_64, install the `.deb` with your software installer or `sudo apt install ./downloaded-file.deb`, then launch **Markwrite** from the application menu. For the portable archive, extract it to a permanent folder and run the commands below from that folder: the first starts the app; the second creates application-menu and desktop shortcuts. Your desktop may require “Allow Launching” the first time. Rerun the shortcut installer after moving the folder. Linux development and checks primarily use Ubuntu 22.04 / GNOME / X11.

- **Debian/Ubuntu 安装包：**下载 `.deb`，在系统软件安装器中打开；也可使用 `sudo apt install ./下载的文件名.deb`。安装后从应用菜单启动 **Markwrite**。
- **便携包：**解压到固定位置，在解压目录运行以下命令。便携包需要包含 `bin/markwrite`，单纯下载源代码不包含这个已编译程序。

```bash
./scripts/launch.sh
./scripts/install-desktop.sh
```

第二条命令创建应用菜单和桌面入口；桌面可能需要首次右键“允许启动”。移动目录后重新执行。文件默认关联可在设置中单独启用。

### Windows

目标为 Windows 10 / 11 x86_64。下载 NSIS `*-setup.exe`，选择简体中文或英文，默认安装到当前用户目录；从开始菜单中的 **Markwrite** 启动。

**English:** On Windows 10/11 x86_64, run the `*-setup.exe` installer, choose Chinese or English, and launch **Markwrite** from the Start menu. Installation defaults to your user directory. WebView2 is required; if missing, the installer downloads Microsoft’s official bootstrapper, so first-time setup may need internet access. The installer is currently unsigned. To associate `.md` and `.markdown`, use **Settings → Files → Default application**, then complete the selection in Windows Default Apps and refresh the status in Markwrite.

运行使用系统 WebView2；缺少时安装器会下载 Microsoft 官方引导程序，因此首次安装可能需要网络。安装包当前未做商业代码签名。已有 WebView2 后，本地写作和导出无需联网。

设置中的默认应用按钮会打开 Windows 系统设置，请在那里完成 `.md` 和 `.markdown` 关联。此版本的 Windows 构建、安装、文件关联命令、启动与关闭验收记录见下方测试状态。

## 常用快捷键

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

完整菜单仍可使用鼠标操作。系统占用某个快捷键时，可使用相应菜单。

## 从源码开发、构建和测试

使用 Node.js 24、Rust stable（最低 1.88），依赖版本由 `package-lock.json` 和 `src-tauri/Cargo.lock` 锁定。

### Linux 开发环境

Ubuntu 22.04 / 24.04 可安装构建库与桌面关联工具：

```bash
sudo apt install build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libglib2.0-bin xdg-utils desktop-file-utils
npm ci
npm run tauri dev
```

### Windows 开发环境

准备 Node.js 24、Rust MSVC 工具链、Visual Studio C++ Build Tools 和 WebView2，然后执行：

```powershell
npm ci
npm run tauri dev
```

### 测试与打包

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Linux 打包：

```bash
npm run tauri -- build --bundles deb
```

Windows 打包：

```powershell
npm run tauri -- build --config src-tauri/tauri.windows.conf.json --bundles nsis
```

默认产物目录分别为 `src-tauri/target/release/bundle/deb/` 与 `src-tauri/target/release/bundle/nsis/`；设置了 `CARGO_TARGET_DIR` 时以实际构建输出为准。

`npm run dev` 可在浏览器预览，默认地址为 `http://127.0.0.1:1420`。浏览器不提供原生历史、回收站、Git、AI、服务上传或默认文件关联；文件授权和草稿容量也与桌面版不同，不能代替桌面验收。

[Desktop builds 工作流](.github/workflows/desktop.yml) 在 Linux 和 Windows runner 运行前端测试、Rust 测试并打包。Windows 还包含 NSIS 安装、带空格安装路径的文件关联、中文文件参数、窗口出现、系统关闭消息和卸载检查。

0.5.0 本机通过 **928 项前端测试**（另有 2 项可选性能诊断默认跳过）、**77 项 Linux 原生测试**（1 个子进程辅助入口和 1 项可选性能诊断忽略独立运行），TypeScript 与 Rust 格式检查通过；另行执行的 1MiB / 10MiB 编辑诊断两项通过。覆盖 CommonMark 官方全部 652 个示例、只读恢复权限、渐进目录、编码往返、跨进程冲突与 ZIP 原文件保持。真实浏览器另验证 10,000 段全文查找、末段复制、脚注往返、书签与阅读位置、Mermaid、HTML/纯文本剪贴板与两页 PDF 输出。Linux 原生双进程实际键入草稿后，终止一个进程，另一个继续滚动并正常退出；双方重开恢复草稿，原文件 hash 与修改时间未变。[最终 Linux / Windows CI 与安装验收](https://github.com/asoming/markwrite/actions/runs/34674770523) 全部通过；Windows 原生测试 **69 项通过、2 项忽略**，安装、中文及空格路径关联、独立进程、会话恢复、原文件保持和卸载均通过。Linux 安装包还实际验证了 `Ctrl+Shift+N` 创建新进程，以及 PDF 目录、正文表格、行内公式和翻页。

**1 秒首屏仍是优化目标，尚未作为达标承诺。** 1 MiB 文档在私有 Xephyr 软件渲染环境中，从启动进程到辅助功能接口读到正文，单次样本为 **1.435 秒**（250ms 轮询）；小文档源码编辑样本为 1.470 / 1.713 秒。该测量不是普通桌面硬件上的重复冷启动基准；单文件上限与巨型单块、复杂图表的成本仍然存在。

0.5.0 passes **928 frontend tests** (two optional performance diagnostics skipped), **77 native Linux tests** (one child-process helper and one optional benchmark excluded from standalone execution), TypeScript and Rust formatting. Both optional 1MiB / 10MiB editing diagnostics also passed. Real-browser checks cover 10,000 paragraphs, full-document copying, search, footnotes, bookmarks, restored positions, Mermaid, HTML/plain clipboard formats and a two-page PDF. A native Linux test typed drafts into separate processes, terminated one, scrolled and closed the survivor normally, then recovered both drafts without changing source hashes or modification times. [Final Linux / Windows CI and installer checks](https://github.com/asoming/markwrite/actions/runs/34674770523) passed. Windows passed **69 native tests with two ignored**, installation, quoted/Chinese filename association, independent processes, session recovery, unchanged sources and removal. The Linux package additionally verified `Ctrl+Shift+N` process creation and actual PDF contents, body tables, inline math and page navigation.

**The one-second target remains unproven.** One 1MiB sample took **1.435 seconds** from process launch to accessible reader content under private Xephyr software rendering with 250ms polling; small source-editor samples took 1.470 / 1.713 seconds. These are individual instrumented samples, not repeated cold-start benchmarks on normal desktop hardware. Single-file limits and unusually large individual blocks or diagrams still apply.

上一版本 0.4.0 在本机通过 **228 项前端测试**（默认跳过 2 项可选诊断）、**61 项 Linux 原生测试**（跳过 1 项可选诊断），TypeScript、生产构建与 Rust 格式检查通过。1MiB/10MiB 编辑诊断另行运行，两项均通过。另已在隐藏的独立显示环境中，验证预先持久化的中英草稿在强制终止程序后完整恢复，保存基线和未保存状态均保留；这不代表真实键入、断电或写入中断测试。此版的 [Linux / Windows 构建与安装验收](https://github.com/asoming/markwrite/actions/runs/34603110391) 全部通过，其中 Windows 通过 **54 项原生测试**（跳过 1 项可选诊断），并通过安装、带空格路径的文件关联命令、中文参数解析、启动、正常关闭和卸载检查。

Linux 原生发布版另已验证：只打开一篇文档时，WebKit 后台 Worker 能读取同目录另外两篇磁盘文档，正确显示它们的反向链接和中英文标签；测试文档保持不变。测试使用正式构建的协议和 CSP，在隐藏的独立显示环境中操作。

真实 Chrome 验证了表格输入/撤销/重做、浏览器组合输入事件、图片尺寸/拖动/阅读预览、8 页 A5 PDF 和 DOCX 输出。使用真实工具面板和 Worker 的 1,000/10,000 篇合成文档测试中，切换标签/反链/当前文档没有重新解析全文，各只读取一次工作区快照；改一篇只增加一次解析，列表首批 100 项。该夹具以内存代替磁盘扫描，不代表原生启动、实际磁盘或所有设备的耗时。

**English — previous 0.4.0 release:** Local validation passed **228 frontend tests** (two optional diagnostics skipped), **61 native Linux tests** (one optional diagnostic skipped), TypeScript, the production build, and Rust formatting. Both opt-in 1MiB/10MiB editing diagnostics also passed. An isolated native process-kill check also recovered a preseeded persisted bilingual draft with its saved baseline and dirty state intact; this was not a typing, power-loss, or interrupted-save test. [Linux / Windows build and installer checks](https://github.com/asoming/markwrite/actions/runs/34603110391) passed. Windows passed **54 native tests** (one optional diagnostic skipped), installer and uninstaller checks, file association commands with spaces, Chinese filename argument parsing, native startup, and normal close checks.

The native Linux release also passed a WebKit worker check under its production protocol and CSP: with one document open, it indexed two other documents on disk and displayed their backlinks and bilingual tags without changing the files. The check ran on a hidden, isolated display.

Real Chrome checks covered table edits and undo/redo, browser composition events, image dimensions/dragging/reading previews, an eight-page A5 PDF, and DOCX output. With the real tool panel and worker indexing 1,000/10,000 synthetic documents, tab/current-file changes did not reparse the documents or reread the workspace snapshot; a single edit reparsed only one document, with 100 rows initially rendered. Workspace disk reads were mocked, so this does not benchmark native startup or filesystem speed.

可选性能诊断：

```bash
MARKWRITE_BENCHMARK=1 npm test -- tests/editor-performance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml benchmark_workspace_search_100mb -- --ignored --nocapture
```

编辑诊断在 Node/jsdom 中检查 1MiB/10MiB 内容挂载、连续输入与全文保留，不含原生绘制和输入法。搜索诊断使用 10,000 个文件、约 100MB 的刚生成夹具，属于热文件缓存。它们不能替代冷启动、真实输入到画面更新 P95 或长期使用验收。

## 已知边界

- 正文超过 300,000 个 UTF-16 字符单位时暂停即时渲染，超过 1,000,000 个时暂停编辑器 Markdown 语法解析；完整正文仍可编辑。这是字符阈值，不是文件字节数。原生单文件打开上限 32MiB。
- IBus libpinyin 在 X11 下的源码/即时编辑候选提交与撤销重做已验证；Fcitx5 / Windows 输入法、Wayland、多屏、125%/150% 缩放、完整冷启动基准、2 小时持续写作和内存趋势仍待验收。
- 不提供多人实时协作、移动端、云端账号同步、全库图谱、自动修复所有引用、高级表格计算或任意方言兼容。
- 图床、发布和 AI 是可选的用户服务连接，不自带云服务或免费额度；本地核心功能不依赖这些接口。
- 安装、构建通过与内容转换无损是不同结果。复杂 HTML/DOCX 导入和 PDF/DOCX 导出请按前述边界检查最终内容。

## 字体与许可证

项目尚未声明整体开源许可证；第三方依赖各自遵循其许可证。

文档主题的来源、适配方式、字体来源和文件校验值列在 **[public/themes/NOTICE.txt](public/themes/NOTICE.txt)**。Pixyll 衍生样式保留 **[MIT 许可证](public/themes/pixyll/LICENSE.txt)**；随附 Open Sans 使用 **[Apache License 2.0](public/themes/github/Apache-2.0.txt)**，PT Serif、Merriweather、Lato、Vollkorn 各自的 SIL Open Font License 文件保存在对应主题目录，具体链接和版权信息见 NOTICE。分发应用时须一并保留这些文件。

离线 PDF 使用随包提供的 Noto Sans CJK 简体中文常规/粗体字体。来源、提取方式与版权说明保存在 **[public/fonts/NOTICE.txt](public/fonts/NOTICE.txt)**，字体许可证为 **[SIL Open Font License 1.1](public/fonts/OFL.txt)**。分发应用时保留字体及这些许可说明；字体许可只针对字体文件，不因此要求导出的文档采用相同许可证。应用不会将这些字体安装到系统字体目录。
