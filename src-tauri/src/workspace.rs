use crate::{history, is_markdown, recovery, storage, AppState};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{Emitter, State};

#[derive(Clone, Debug, Serialize)]
pub struct Hit {
    pub path: String,
    pub line: usize,
    pub text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProgress {
    request_id: Option<String>,
    hits: Vec<Hit>,
}
fn visit_markdown(
    path: &Path,
    depth: usize,
    count: &mut usize,
    cancelled: &dyn Fn() -> bool,
    visit: &mut dyn FnMut(&Path) -> Result<bool, String>,
) -> Result<bool, String> {
    if cancelled() {
        return Err("CANCELLED".into());
    }
    if depth > 32 {
        return Err("目录超过 32 层，请打开更具体的工作文件夹。".into());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        if cancelled() {
            return Err("CANCELLED".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink()
            || name.starts_with('.')
            || ["node_modules", "target"].contains(&name.as_ref())
        {
            continue;
        }
        if kind.is_dir() {
            if !visit_markdown(&entry.path(), depth + 1, count, cancelled, visit)? {
                return Ok(false);
            }
        } else if kind.is_file() && is_markdown(&entry.path()) {
            *count += 1;
            if *count > 100_000 {
                return Err("工作文件夹超过 100,000 个 Markdown 文件，请缩小搜索范围。".into());
            }
            if !visit(&entry.path())? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
fn search(
    path: &Path,
    query: &str,
    generation: &AtomicU64,
    own: u64,
    progress: &mut dyn FnMut(&[Hit]),
) -> Result<Vec<Hit>, String> {
    let cancelled = || generation.load(Ordering::Acquire) != own;
    let mut hits = Vec::new();
    let mut batch = Vec::new();
    visit_markdown(path, 0, &mut 0, &cancelled, &mut |file| {
        if let Ok(document) = storage::read(file) {
            for (i, line) in document.content.lines().enumerate() {
                if i % 128 == 0 && cancelled() {
                    return Err("CANCELLED".into());
                }
                if line.to_lowercase().contains(query) {
                    let hit = Hit {
                        path: file.to_string_lossy().into_owned(),
                        line: i + 1,
                        text: line.chars().take(240).collect(),
                    };
                    batch.push(hit.clone());
                    hits.push(hit);
                    if batch.len() >= 20 || hits.len() == 1 {
                        progress(&batch);
                        batch.clear();
                    }
                    if hits.len() >= 500 {
                        return Ok(false);
                    }
                }
            }
        }
        Ok(true)
    })?;
    if cancelled() {
        return Err("CANCELLED".into());
    }
    if !batch.is_empty() {
        progress(&batch);
    }
    Ok(hits)
}
#[tauri::command]
pub async fn search_folder(
    path: String,
    query: String,
    request_id: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Hit>, String> {
    let path = state.check_directory(Path::new(&path))?;
    let own;
    {
        let mut current = state.search_request.lock().map_err(|e| e.to_string())?;
        own = state.search_generation.fetch_add(1, Ordering::AcqRel) + 1;
        *current = request_id.clone();
    }
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let generation = Arc::clone(&state.search_generation);
    tauri::async_runtime::spawn_blocking(move || {
        search(
            &path,
            &query.to_lowercase(),
            &generation,
            own,
            &mut |hits| {
                let _ = app.emit(
                    "search-progress",
                    SearchProgress {
                        request_id: request_id.clone(),
                        hits: hits.to_vec(),
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_search(request_id: Option<String>, state: State<'_, AppState>) -> Result<(), String> {
    let current = state.search_request.lock().map_err(|e| e.to_string())?;
    if request_id.is_none() || *current == request_id {
        state.search_generation.fetch_add(1, Ordering::AcqRel);
    }
    Ok(())
}
#[tauri::command]
pub async fn workspace_documents(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<storage::DiskFile>, String> {
    let path = state.check_directory(Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = vec![];
        let mut bytes = 0;
        visit_markdown(&path, 0, &mut 0, &|| false, &mut |p| {
            if let Ok(file) = storage::read(p) {
                bytes += file.content.len();
                if bytes > 128 * 1024 * 1024 {
                    return Err("索引正文超过 128MB，请打开更小的工作文件夹。".into());
                }
                files.push(file);
            }
            Ok(true)
        })?;
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Debug, Serialize)]
pub struct NamedFile {
    name: String,
    path: String,
}
fn find_names(
    root: &Path,
    query: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<NamedFile>, String> {
    let query = query.to_lowercase();
    let mut files = vec![];
    visit_markdown(root, 0, &mut 0, cancelled, &mut |path| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.to_lowercase().contains(&query) {
            files.push(NamedFile {
                name: name.into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        }
        Ok(files.len() < 500)
    })?;
    files.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    Ok(files)
}
/// Enumerate names on demand without reading documents or building the reference index.
#[tauri::command]
pub async fn find_files(
    path: String,
    query: String,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<NamedFile>, String> {
    let root = state.check_directory(Path::new(&path))?;
    let own;
    {
        let mut current = state.filename_request.lock().map_err(|e| e.to_string())?;
        own = state.filename_generation.fetch_add(1, Ordering::AcqRel) + 1;
        *current = Some(request_id);
    }
    let generation = Arc::clone(&state.filename_generation);
    tauri::async_runtime::spawn_blocking(move || {
        find_names(&root, &query, &|| generation.load(Ordering::Acquire) != own)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_find_files(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if state
        .filename_request
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        == Some(&request_id)
    {
        state.filename_generation.fetch_add(1, Ordering::AcqRel);
    }
    Ok(())
}
#[tauri::command]
pub async fn history_list(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<history::Version>, String> {
    let path = state.check(Path::new(&path))?;
    history::list(&recovery(&app)?, &path)
}
#[tauri::command]
pub async fn history_read(
    path: String,
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    encoding: Option<crate::text_encoding::TextEncoding>,
) -> Result<storage::DiskFile, String> {
    let path = state.check(Path::new(&path))?;
    history::read_with_encoding(&recovery(&app)?, &path, &id, encoding)
}
#[derive(Serialize)]
pub struct TrashFailure {
    path: String,
    error: String,
}
#[derive(Serialize)]
pub struct TrashResult {
    moved: Vec<String>,
    failures: Vec<TrashFailure>,
}
#[tauri::command]
pub async fn trash_entries(
    paths: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<TrashResult, String> {
    if paths.len() > 1000 {
        return Err("一次最多移入回收站 1000 项。".into());
    }
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    let mut result = TrashResult {
        moved: vec![],
        failures: vec![],
    };
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let operation = (|| {
            if fs::symlink_metadata(&path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("请通过系统文件管理器处理符号链接。".into());
            }
            let p = state.check(Path::new(&path))?;
            if !seen.insert(p.clone()) {
                return Ok(false);
            }
            if state
                .access
                .lock()
                .map_err(|e| e.to_string())?
                .roots
                .contains(&p)
            {
                return Err("不能移除当前工作文件夹本身。".into());
            }
            if p.is_file() && is_markdown(&p) {
                history::snapshot(
                    &recovery(&app)?,
                    &p,
                    &fs::read(&p).map_err(|e| e.to_string())?,
                )?;
            }
            trash::delete(&p)
                .map_err(|e| format!("无法移入系统回收站：{e}。文件未主动永久删除。"))?;
            Ok(true)
        })();
        match operation {
            Ok(true) => result.moved.push(path),
            Ok(false) => {}
            Err(error) => result.failures.push(TrashFailure { path, error }),
        }
    }
    Ok(result)
}
#[derive(Serialize)]
pub struct Attachment {
    path: String,
    size: u64,
    references: Vec<String>,
}
#[tauri::command]
pub async fn attachment_inventory(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<Attachment>, String> {
    let root = state.check_directory(Path::new(&path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut docs = vec![];
        let mut total_bytes = 0;
        visit_markdown(&root, 0, &mut 0, &|| false, &mut |p| {
            // Fail closed: unreadable documents make deletion candidates unsafe.
            let doc = storage::read(p)?;
            total_bytes += doc.content.len();
            if total_bytes > 128 * 1024 * 1024 {
                return Err("附件引用扫描超过 128MB，请缩小工作文件夹。".into());
            }
            docs.push((
                doc.path,
                percent_encoding::percent_decode_str(&doc.content)
                    .decode_utf8_lossy()
                    .replace('\\', "/"),
            ));
            Ok(true)
        })?;
        let mut candidates = vec![];
        collect_attachments(&root, false, 0, &mut candidates)?;
        Ok(candidates
            .into_iter()
            .map(|(path, size)| {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let references = docs
                    .iter()
                    .filter(|(_, text)| text.contains(name.as_ref()))
                    .map(|(path, _)| path.clone())
                    .collect();
                Attachment {
                    path: path.to_string_lossy().into_owned(),
                    size,
                    references,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn collect_attachments(
    path: &Path,
    in_assets: bool,
    depth: usize,
    files: &mut Vec<(PathBuf, u64)>,
) -> Result<(), String> {
    if depth > 32 {
        return Err("附件目录过深。".into());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if kind.is_symlink()
            || name.starts_with('.')
            || ["node_modules", "target"].contains(&name.as_ref())
        {
            continue;
        }
        if kind.is_dir() {
            collect_attachments(
                &entry.path(),
                in_assets || name == "assets",
                depth + 1,
                files,
            )?;
        } else if in_assets && kind.is_file() {
            files.push((
                entry.path(),
                entry.metadata().map_err(|e| e.to_string())?.len(),
            ));
            if files.len() > 10000 {
                return Err("附件超过 10,000 项，请缩小工作文件夹。".into());
            }
        }
    }
    Ok(())
}
fn git(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.hooksPath=")
        .arg("-C")
        .arg(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn success(output: Output) -> Result<Vec<u8>, String> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
fn git_root(path: &str, state: &AppState) -> Result<PathBuf, String> {
    let root = state.check_directory(Path::new(path))?;
    let top = success(
        git(&root)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .map_err(|e| format!("请安装 Git 并加入 PATH：{e}"))?,
    )?;
    let top = Path::new(String::from_utf8_lossy(&top).trim())
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if root != top {
        return Err("请打开 Git 仓库根文件夹后操作。".into());
    }
    Ok(root)
}
fn safe_relative(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if name.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Git 文件路径必须位于当前仓库内。".into());
    }
    let candidate = root.join(path);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or("文件路径无效。")?;
    }
    if !existing
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(root)
    {
        return Err("文件路径通过链接指向仓库外。".into());
    }
    Ok(candidate)
}
#[derive(Serialize)]
pub struct GitEntry {
    path: String,
    index: String,
    worktree: String,
}
#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    entries: Vec<GitEntry>,
    available: bool,
    repository: bool,
    merging: bool,
}
fn parse_status(data: &[u8]) -> Vec<GitEntry> {
    let mut parts = data.split(|c| *c == 0);
    let mut entries = vec![];
    while let Some(item) = parts.next() {
        if item.len() < 4 {
            continue;
        }
        let index = (item[0] as char).to_string();
        let worktree = (item[1] as char).to_string();
        entries.push(GitEntry {
            path: String::from_utf8_lossy(&item[3..]).into_owned(),
            index,
            worktree,
        });
        if [b'R', b'C'].contains(&item[0]) || [b'R', b'C'].contains(&item[1]) {
            parts.next();
        }
    }
    entries
}
#[tauri::command]
pub async fn git_status(path: String, state: State<'_, AppState>) -> Result<GitStatus, String> {
    let root = state.check_directory(Path::new(&path))?;
    if git(&root).arg("--version").output().is_err() {
        return Ok(GitStatus {
            branch: String::new(),
            entries: vec![],
            available: false,
            repository: false,
            merging: false,
        });
    }
    let Ok(root) = git_root(&path, &state) else {
        return Ok(GitStatus {
            branch: String::new(),
            entries: vec![],
            available: true,
            repository: false,
            merging: false,
        });
    };
    let entries = parse_status(&success(
        git(&root)
            .args([
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--no-renames",
            ])
            .output()
            .map_err(|e| e.to_string())?,
    )?);
    let branch = git(&root)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| success(o).ok())
        .map(|s| String::from_utf8_lossy(&s).trim().to_string())
        .unwrap_or_else(|| "游离 HEAD".into());
    Ok(GitStatus {
        branch,
        entries,
        available: true,
        repository: true,
        merging: merging(&root),
    })
}
fn merging(root: &Path) -> bool {
    git(root)
        .args(["rev-parse", "--verify", "-q", "MERGE_HEAD"])
        .output()
        .is_ok_and(|output| output.status.success())
}
fn mark_resolved(root: &Path, file: &str) -> Result<(), String> {
    let target = safe_relative(root, file)?;
    if success(
        git(root)
            .args(["ls-files", "--unmerged", "-z", "--", file])
            .output()
            .map_err(|e| e.to_string())?,
    )?
    .is_empty()
    {
        return Err("该文件已无未解决冲突，请刷新状态。 / This file no longer has an unresolved conflict; refresh status.".into());
    }
    if target.exists() {
        let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > 8 * 1024 * 1024 {
            return Err("请选择不超过 8MiB 的普通文本冲突文件。 / Choose a regular text conflict file up to 8MiB.".into());
        }
        let bytes = fs::read(&target).map_err(|e| e.to_string())?;
        let text = std::str::from_utf8(&bytes).map_err(|_| "非 UTF-8 冲突请使用系统 Git 工具解决。 / Resolve non-UTF-8 conflicts with your Git tool.")?;
        if text.lines().any(|line| {
            ["<<<<<<<", ">>>>>>>", "|||||||"]
                .iter()
                .any(|marker| line.starts_with(marker))
        }) {
            return Err("文件仍含冲突标记，请编辑并保存后再标记解决。 / Conflict markers remain. Edit and save before marking resolved.".into());
        }
    }
    success(
        git(root)
            .args(["add", "--", file])
            .output()
            .map_err(|e| e.to_string())?,
    )?;
    Ok(())
}
#[tauri::command]
pub async fn git_mark_resolved(
    path: String,
    file: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = git_root(&path, &state)?;
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    mark_resolved(&root, &file)
}
#[tauri::command]
pub async fn git_diff(
    path: String,
    file: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = git_root(&path, &state)?;
    if let Some(ref name) = file {
        safe_relative(&root, name)?;
    }
    let mut text = String::new();
    for cached in [false, true] {
        let mut command = git(&root);
        command.args(["diff", "--no-ext-diff", "--no-textconv"]);
        if cached {
            command.arg("--cached");
        }
        command.arg("--");
        if let Some(ref name) = file {
            command.arg(name);
        }
        let bytes = success(command.output().map_err(|e| e.to_string())?)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("差异超过 8MB，请用系统 Git 工具查看。".into());
        }
        if !bytes.is_empty() {
            text.push_str(if cached {
                "\n已暂存更改\n"
            } else {
                "\n工作区更改\n"
            });
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    if text.is_empty() {
        if let Some(name) = file {
            let tracked = success(
                git(&root)
                    .args(["ls-files", "--", &name])
                    .output()
                    .map_err(|e| e.to_string())?,
            )?;
            if tracked.is_empty() {
                let target = safe_relative(&root, &name)?;
                let metadata = fs::metadata(&target).map_err(|e| e.to_string())?;
                if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
                    return Err("请选择小于 8MB 的文本文件查看差异。".into());
                }
                let contents =
                    fs::read_to_string(target).map_err(|_| "这是二进制文件，无法预览文本差异。")?;
                text = format!(
                    "新文件：{name}\n{}",
                    contents
                        .lines()
                        .map(|line| format!("+{line}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                );
            }
        }
    }
    Ok(text)
}
#[tauri::command]
pub async fn git_init(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = state.check_directory(Path::new(&path))?;
    success(
        git(&root)
            .args(["init"])
            .output()
            .map_err(|e| format!("请安装 Git：{e}"))?,
    )?;
    Ok(())
}
#[tauri::command]
pub async fn git_commit(
    path: String,
    paths: Vec<String>,
    message: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("请输入提交说明。".into());
    }
    if paths.len() > 1000 {
        return Err("请选择 1–1000 个要提交的文件。".into());
    }
    let root = git_root(&path, &state)?;
    if paths.is_empty() && !merging(&root) {
        return Err("请选择要提交的文件。 / Select files to commit.".into());
    }
    for name in &paths {
        safe_relative(&root, name)?;
    }
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    commit_selected(&root, paths, message)
}
fn commit_selected(root: &Path, paths: Vec<String>, message: String) -> Result<String, String> {
    if !success(
        git(&root)
            .args(["ls-files", "--unmerged", "-z"])
            .output()
            .map_err(|e| e.to_string())?,
    )?
    .is_empty()
    {
        return Err("仓库有未解决的合并冲突。请先查看差异并解决冲突。".into());
    }
    if merging(root) {
        let staged = success(
            git(root)
                .args(["diff", "--cached", "--name-only", "-z", "--no-renames"])
                .output()
                .map_err(|e| e.to_string())?,
        )?;
        let staged: std::collections::BTreeSet<_> = staged
            .split(|byte| *byte == 0)
            .filter(|item| !item.is_empty())
            .map(|item| String::from_utf8_lossy(item).into_owned())
            .collect();
        if staged != paths.into_iter().collect() {
            return Err("合并提交包含全部已暂存文件，请刷新并选择全部已暂存项。 / A merge commit includes all staged files. Refresh and select all staged paths.".into());
        }
        let result = success(
            git(root)
                .args(["-c", "commit.gpgsign=false", "commit", "-m"])
                .arg(message)
                .output()
                .map_err(|e| e.to_string())?,
        )?;
        return Ok(String::from_utf8_lossy(&result).trim().to_string());
    }
    // --only commits the explicitly selected paths; unrelated staged work is retained.
    success(
        git(&root)
            .args(["add", "--"])
            .args(&paths)
            .output()
            .map_err(|e| e.to_string())?,
    )?;
    let output = success(
        git(&root)
            .args(["-c", "commit.gpgsign=false", "commit", "--only", "-m"])
            .arg(message)
            .arg("--")
            .args(paths)
            .output()
            .map_err(|e| e.to_string())?,
    )?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filename_search_is_recursive_name_only_bounded_and_cancellable() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-names-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("深层/another")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        // Invalid UTF-8 confirms that finding a filename does not read/decode its contents.
        fs::write(root.join("深层/another/目标.MD"), [255u8, 254]).unwrap();
        fs::write(root.join("other.md"), "目标").unwrap();
        fs::write(root.join("node_modules/目标.md"), "ignored").unwrap();
        let hits = find_names(&root, "目标", &|| false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "目标.MD");
        assert!(find_names(&root, "", &|| true)
            .unwrap_err()
            .contains("CANCELLED"));
        for n in 0..550 {
            fs::write(root.join(format!("file-{n}.md")), "").unwrap();
        }
        assert_eq!(find_names(&root, "file-", &|| false).unwrap().len(), 500);
        fs::remove_dir_all(root).unwrap();
    }
    fn conflicted_test_repository(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "markwrite-resolve-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.invalid"],
        ] {
            success(git(&root).args(args).output().unwrap()).unwrap();
        }
        fs::write(root.join("冲突.md"), "original\n").unwrap();
        fs::write(root.join("other.md"), "original\n").unwrap();
        commit_selected(
            &root,
            vec!["冲突.md".into(), "other.md".into()],
            "base".into(),
        )
        .unwrap();
        success(
            git(&root)
                .args(["checkout", "-b", "other"])
                .output()
                .unwrap(),
        )
        .unwrap();
        fs::write(root.join("冲突.md"), "theirs\n").unwrap();
        commit_selected(&root, vec!["冲突.md".into()], "theirs".into()).unwrap();
        success(
            git(&root)
                .args(["checkout", "-b", "ours", "HEAD~1"])
                .output()
                .unwrap(),
        )
        .unwrap();
        fs::write(root.join("冲突.md"), "ours\n").unwrap();
        commit_selected(&root, vec!["冲突.md".into()], "ours".into()).unwrap();
        assert!(!git(&root)
            .args(["merge", "other"])
            .output()
            .unwrap()
            .status
            .success());
        // Production callers obtain a canonical root from git_root. Match that
        // contract here, including the Windows verbatim path prefix.
        root.canonicalize().unwrap()
    }
    #[test]
    fn resolved_merge_requires_explicit_selection_of_all_staged_files() {
        let root = conflicted_test_repository("content");
        assert!(mark_resolved(&root, "冲突.md")
            .unwrap_err()
            .contains("Conflict markers"));
        assert!(mark_resolved(&root, "../escape.md").is_err());
        fs::write(root.join("冲突.md"), "both combined\n").unwrap();
        mark_resolved(&root, "冲突.md").unwrap();
        assert!(mark_resolved(&root, "冲突.md").is_err());
        fs::write(root.join("other.md"), "also staged\n").unwrap();
        success(git(&root).args(["add", "--", "other.md"]).output().unwrap()).unwrap();
        assert!(
            commit_selected(&root, vec!["冲突.md".into()], "merge".into())
                .unwrap_err()
                .contains("all staged")
        );
        commit_selected(
            &root,
            vec!["冲突.md".into(), "other.md".into()],
            "merge resolved".into(),
        )
        .unwrap();
        assert!(!merging(&root));
        let parents = success(
            git(&root)
                .args(["rev-list", "--parents", "-n", "1", "HEAD"])
                .output()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&parents).split_whitespace().count(),
            3
        );
        assert_eq!(
            fs::read_to_string(root.join("冲突.md")).unwrap(),
            "both combined\n"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn merge_can_keep_ours_with_no_staged_content_changes() {
        let root = conflicted_test_repository("unchanged");
        fs::write(root.join("冲突.md"), "ours\n").unwrap();
        mark_resolved(&root, "冲突.md").unwrap();
        commit_selected(&root, vec![], "resolve by retaining ours".into()).unwrap();
        assert!(!merging(&root));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn resolving_a_conflict_can_explicitly_retain_deletion() {
        let root = conflicted_test_repository("delete");
        fs::remove_file(root.join("冲突.md")).unwrap();
        mark_resolved(&root, "冲突.md").unwrap();
        commit_selected(&root, vec!["冲突.md".into()], "keep deletion".into()).unwrap();
        assert!(!root.join("冲突.md").exists());
        assert!(!merging(&root));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn git_status_handles_spaces_and_renames() {
        let result = parse_status(" M a b.md\0R  new.md\0old.md\0?? 文档.md\0".as_bytes());
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].path, "a b.md");
        assert_eq!(result[1].path, "new.md");
    }
    #[test]
    fn cancelled_search_stops_before_io() {
        assert_eq!(
            search(
                Path::new("/missing"),
                "x",
                &AtomicU64::new(2),
                1,
                &mut |_| {}
            )
            .unwrap_err(),
            "CANCELLED"
        );
    }
    #[test]
    fn search_finds_chinese_and_ignores_private_directories() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-search-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("中文.md"), "# 记录\n寻找目标\n末尾").unwrap();
        fs::write(root.join(".git/hidden.md"), "目标").unwrap();
        let mut first = 0;
        let result = search(&root, "目标", &AtomicU64::new(1), 1, &mut |hits| {
            first += hits.len()
        })
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].line, 2);
        assert_eq!(first, 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn running_search_can_be_cancelled_from_progress_callback() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-search-cancel-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.md"), "match\n".repeat(10000)).unwrap();
        let generation = AtomicU64::new(1);
        let result = search(&root, "match", &generation, 1, &mut |_| {
            generation.store(2, Ordering::Release);
        });
        assert!(result.unwrap_err().starts_with("CANCELLED"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "creates a 100 MiB / 10,000 document performance fixture; run explicitly"]
    fn benchmark_workspace_search_100mb() {
        let root =
            std::env::temp_dir().join(format!("markwrite-search-benchmark-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let text = format!(
            "{}\nbenchmark-unique-target\n",
            "文档内容 abcdefghijklmnopqrstuvwxyz\n".repeat(250)
        );
        for i in 0..10000 {
            fs::write(root.join(format!("doc-{i:05}.md")), &text).unwrap();
        }
        let bytes = text.len() * 10000;
        let start = std::time::Instant::now();
        let mut first = None;
        let found = search(
            &root,
            "benchmark-unique-target",
            &AtomicU64::new(1),
            1,
            &mut |_| {
                first.get_or_insert(start.elapsed());
            },
        )
        .unwrap();
        println!(
            "benchmark bytes={bytes} files=10000 first_hit_ms={} first_500_ms={} hits={}",
            first.unwrap().as_millis(),
            start.elapsed().as_millis(),
            found.len()
        );
        let start = std::time::Instant::now();
        let absent = search(
            &root,
            "nonexistent-target-xyz",
            &AtomicU64::new(1),
            1,
            &mut |_| {},
        )
        .unwrap();
        println!(
            "benchmark full_scan_ms={} hits={}",
            start.elapsed().as_millis(),
            absent.len()
        );
        let gen = AtomicU64::new(1);
        let start = std::time::Instant::now();
        assert!(search(&root, "benchmark-unique-target", &gen, 1, &mut |_| {
            gen.store(2, Ordering::Release);
        })
        .is_err());
        println!(
            "benchmark cancel_on_first_hit_ms={}",
            start.elapsed().as_millis()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selected_commit_preserves_other_staged_changes_and_disables_hooks() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-git-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        success(git(&root).arg("init").output().unwrap()).unwrap();
        success(
            git(&root)
                .args(["config", "user.name", "Markwrite Test"])
                .output()
                .unwrap(),
        )
        .unwrap();
        success(
            git(&root)
                .args(["config", "user.email", "test@example.invalid"])
                .output()
                .unwrap(),
        )
        .unwrap();
        fs::write(root.join("a.md"), "a0").unwrap();
        fs::write(root.join("b.md"), "b0").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for hook in [root.join(".git/hooks/pre-commit"), root.join("pre-commit")] {
                fs::write(&hook, "#!/bin/sh\nexit 9\n").unwrap();
                fs::set_permissions(hook, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        commit_selected(&root, vec!["a.md".into(), "b.md".into()], "initial".into()).unwrap();
        fs::write(root.join("a.md"), "a1").unwrap();
        fs::write(root.join("b.md"), "b1").unwrap();
        success(git(&root).args(["add", "--", "b.md"]).output().unwrap()).unwrap();
        commit_selected(&root, vec!["a.md".into()], "selected".into()).unwrap();
        assert_eq!(
            success(git(&root).args(["show", "HEAD:b.md"]).output().unwrap()).unwrap(),
            b"b0"
        );
        let staged = success(
            git(&root)
                .args(["diff", "--cached", "--", "b.md"])
                .output()
                .unwrap(),
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&staged).contains("+b1"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn paths_reject_traversal() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        assert!(safe_relative(&root, "../outside").is_err());
        assert!(safe_relative(&root, "/outside").is_err());
    }
}
