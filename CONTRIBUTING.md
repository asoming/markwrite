# 参与贡献 · Contributing

欢迎修复问题、改善文档和翻译，或提出具体使用场景。提交前先搜索已有 [Issues](https://github.com/asoming/markwrite/issues)，较大的功能改动建议先开 Issue 讨论。中文和英文都可以。

Bug fixes, documentation, translations, and concrete use cases are welcome. Search existing [issues](https://github.com/asoming/markwrite/issues) first; discuss substantial features in an issue before implementing them. Chinese and English are both welcome.

## 本地开发 · Local development

需要 Node.js 24、Rust 1.88 或更新版本，以及对应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。Linux CI 使用以下系统包；Windows 和 macOS 的依赖请按该指南安装。

Use Node.js 24, Rust 1.88 or newer, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. Linux CI uses the packages below; follow the linked guide for Windows and macOS.

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf
```

在仓库根目录执行 / From the repository root:

```bash
npm ci
npm run tauri -- dev
```

只预览前端界面可运行 `npm run dev`；文件系统、Git、系统关联等原生功能需要桌面应用验证。源代码主要在 `src/`（界面和编辑器）和 `src-tauri/src/`（原生服务）。

Use `npm run dev` for a browser-only UI preview. Test native features such as filesystem access, Git, and file associations in the desktop app. Frontend and editor code lives in `src/`; native services live in `src-tauri/src/`.

## 验证改动 · Validate changes

运行与改动相关的检查，并在 PR 中注明执行结果和未验证的平台。修复行为问题时补上能复现问题的回归测试；纯文档改动检查链接和呈现即可。无需为了小改动在本地重建所有平台安装包。

Run checks relevant to your change and note the results and untested platforms in the PR. Add a regression test when fixing a behavioral bug. For documentation-only changes, check links and rendering; small changes do not require building every platform locally.

```bash
npm test -- path/to/affected.test.ts
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked test_name
```

将示例测试路径或 `test_name` 换成实际目标。完整检查分别使用 `npm test` 和 `cargo test --manifest-path src-tauri/Cargo.toml --locked`。CI 负责 Linux、Windows 和两种架构的 macOS 构建及检查。

Replace the example test path or `test_name` with the relevant target. Run the full suites with `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml --locked`. CI builds and checks Linux, Windows, and both macOS architectures.

## 提交问题与 PR · Issues and pull requests

- 描述问题、期望结果和复现步骤；附上 Markwrite 版本、系统版本和安装方式。界面改动可附截图。 / Include the problem, expected behavior, reproduction steps, Markwrite version, OS version, and installation method. Screenshots help with UI changes.
- 使用最小示例文档。上传日志、截图或配置前删除 API Key、访问令牌、私人文档内容及个人信息。 / Use a minimal sample document. Remove API keys, access tokens, private document content, and personal information before uploading logs, screenshots, or settings.
- PR 保持主题集中，简要说明问题、改动与验证。保留现有第三方版权和许可证说明。 / Keep each PR focused and describe the problem, change, and validation. Preserve existing third-party notices and licenses.

你提交的原创贡献按本仓库的 [MIT 许可证](LICENSE) 发布。第三方代码、主题和字体仍遵循各自许可证；引入第三方内容时需附来源与适用许可证。现有说明见 [主题](public/themes/NOTICE.txt) 和 [字体](public/fonts/NOTICE.txt)。

Original contributions are submitted under this repository's [MIT License](LICENSE). Third-party code, themes, and fonts retain their own licenses. Include the source and applicable license when adding third-party material. See the existing [theme](public/themes/NOTICE.txt) and [font](public/fonts/NOTICE.txt) notices.
