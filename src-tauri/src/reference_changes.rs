//! User-confirmed moves with an explicit, version-checked set of document edits.
//! Content is written before the move so a failed move can restore the originals.
use crate::{history, is_markdown, persist_access, recovery, storage, valid_name, AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

static NONCE: AtomicU64 = AtomicU64::new(0);
const MAX_CHANGES: usize = 2_000;
const MAX_CHANGE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceChange {
    path: String,
    next_path: String,
    before: String,
    after: String,
    expected_version: String,
}
#[derive(Serialize)]
pub struct ReferenceResult {
    path: String,
    files: Vec<storage::DiskFile>,
    warnings: Vec<String>,
}
struct PreparedChange {
    path: PathBuf,
    next_path: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
    result: storage::DiskFile,
}
struct Plan {
    from: PathBuf,
    to: PathBuf,
    directory: bool,
    changes: Vec<PreparedChange>,
    moved_documents: Vec<PathBuf>,
    #[cfg(test)]
    fault: Option<Fault>,
}

fn unique(prefix: &str) -> String {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{}-{time}-{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("移动与引用更新只接受规范的绝对路径。".into());
    }
    Ok(())
}
fn no_links(path: &Path) -> Result<(), String> {
    absolute(path)?;
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor).map_err(|e| format!("路径无法访问：{e}"))?;
        if is_link(&metadata) {
            return Err("此操作不支持符号链接或重解析点，请选择实际文件或目录。".into());
        }
    }
    Ok(())
}
fn canonical_existing(path: &Path) -> Result<PathBuf, String> {
    no_links(path)?;
    path.canonicalize().map_err(|e| e.to_string())
}
fn proposed_path(path: &Path) -> Result<PathBuf, String> {
    absolute(path)?;
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(&ancestor) {
            Ok(_) => {
                let mut result = canonical_existing(&ancestor)?;
                if !suffix.is_empty() && !result.is_dir() {
                    return Err("目标父路径不是目录。".into());
                }
                for part in suffix.into_iter().rev() {
                    result.push(part);
                }
                return Ok(result);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(ancestor.file_name().ok_or("目标路径无效。")?.to_os_string());
                if !ancestor.pop() {
                    return Err("目标路径没有有效父目录。".into());
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}
fn absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err("目标已存在，不能覆盖。请选择其他名称或位置。".into()),
        Err(error) => Err(error.to_string()),
    }
}
fn rebase(path: &Path, from: &Path, to: &Path) -> PathBuf {
    path.strip_prefix(from)
        .map(|suffix| {
            if suffix.as_os_str().is_empty() {
                to.to_path_buf()
            } else {
                to.join(suffix)
            }
        })
        .unwrap_or_else(|_| path.to_path_buf())
}
fn collect_documents(
    path: &Path,
    depth: usize,
    count: &mut usize,
    docs: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > 32 || *count > 100_000 {
        return Err("目录超过 32 层或 100,000 项，请移动更小的目录。".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if is_link(&metadata) {
        return Err("目录内包含符号链接或重解析点，尚不支持批量移动。".into());
    }
    *count += 1;
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            collect_documents(
                &entry.map_err(|e| e.to_string())?.path(),
                depth + 1,
                count,
                docs,
            )?;
        }
    } else if metadata.is_file() {
        if is_markdown(path) {
            docs.push(path.to_path_buf());
        }
    } else {
        return Err("移动目录中包含非常规文件。".into());
    }
    Ok(())
}

fn prepare(
    state: &AppState,
    root: Option<&str>,
    from: &Path,
    to: &Path,
    changes: Vec<ReferenceChange>,
) -> Result<Plan, String> {
    if let Some(root) = root {
        state.check_directory(Path::new(root))?;
    }
    if changes.len() > MAX_CHANGES {
        return Err("一次最多更新 2,000 个引用文档。".into());
    }
    let from = canonical_existing(from)?;
    state.check(&from)?;
    let source_metadata = fs::metadata(&from).map_err(|e| e.to_string())?;
    if !source_metadata.is_file() && !source_metadata.is_dir() {
        return Err("请选择常规文件或目录。".into());
    }
    if source_metadata.is_dir() {
        state.check_directory(&from)?;
    }
    absolute(to)?;
    let name = to
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("目标名称无效。")?;
    valid_name(name)?;
    let parent = canonical_existing(to.parent().ok_or("目标没有父目录。")?)?;
    state.check_directory(&parent)?;
    let to = parent.join(name);
    if from == to {
        return Err("目标位置与原位置相同。".into());
    }
    if source_metadata.is_dir() && to.starts_with(&from) {
        return Err("不能将目录移入其自身或子目录。".into());
    }
    absent(&to)?;
    let mut moved_documents = Vec::new();
    collect_documents(&from, 0, &mut 0, &mut moved_documents)?;
    let mut prepared = Vec::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    for change in changes {
        let path = canonical_existing(Path::new(&change.path))?;
        state.check(&path)?;
        if !is_markdown(&path) || !path.is_file() {
            return Err("引用更新只能写入已授权的 Markdown 文档。".into());
        }
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
            return Err("文件超过当前版本的 32MB 限制。".into());
        }
        if !seen.insert(path.clone()) {
            return Err("引用更新包含重复文档。".into());
        }
        let next_path = rebase(&path, &from, &to);
        if proposed_path(Path::new(&change.next_path))? != next_path {
            return Err("引用文档的目标路径与本次移动不匹配，请重新预览。".into());
        }
        let before = fs::read(&path).map_err(|e| e.to_string())?;
        if change.expected_version.is_empty()
            || storage::version(&before) != change.expected_version
        {
            return Err(format!(
                "CONFLICT:文档已在预览后更改：{}。请重新预览。",
                path.display()
            ));
        }
        let mut disk = storage::read(&path)?;
        if disk.version != change.expected_version || disk.content != change.before {
            return Err(format!(
                "CONFLICT:文档内容与预览不一致：{}。请重新预览。",
                path.display()
            ));
        }
        disk.content = change.after.replace("\r\n", "\n");
        let after = storage::serialize(&disk);
        total_bytes = total_bytes
            .saturating_add(before.len())
            .saturating_add(after.len());
        if after.len() > 32 * 1024 * 1024 || total_bytes > MAX_CHANGE_BYTES {
            return Err("引用更新超过文档 32MB 或总内容 128MB 限制，请缩小本次更新范围。".into());
        }
        disk.path = next_path.to_string_lossy().into_owned();
        disk.version = storage::version(&after);
        prepared.push(PreparedChange {
            path,
            next_path,
            before,
            after,
            result: disk,
        });
    }
    Ok(Plan {
        from,
        to,
        directory: source_metadata.is_dir(),
        changes: prepared,
        moved_documents,
        #[cfg(test)]
        fault: None,
    })
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn journal(plan: &Plan, history_root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(history_root).map_err(|e| e.to_string())?;
    let directory = history_root.join(unique("reference-transaction"));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut records = Vec::new();
        for (index, change) in plan.changes.iter().enumerate() {
            let name = format!("{index}.original");
            write_new(&directory.join(&name), &change.before)?;
            records.push(serde_json::json!({ "path": change.path, "nextPath": change.next_path,
                "copy": name, "beforeVersion": storage::version(&change.before), "afterVersion": storage::version(&change.after) }));
        }
        let metadata = serde_json::to_vec_pretty(
            &serde_json::json!({ "from": plan.from, "to": plan.to, "files": records }),
        )
        .map_err(|e| e.to_string())?;
        write_new(&directory.join("transaction.json"), &metadata)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result.map(|_| directory)
}
fn restore_bytes(path: &Path, before: &[u8], after: &[u8]) -> Result<(), String> {
    no_links(path)?;
    let current = fs::read(path).map_err(|e| e.to_string())?;
    if current == before {
        return Ok(());
    }
    if current != after {
        return Err(format!("外部修改已保留，未覆盖：{}", path.display()));
    }
    let temp = path
        .parent()
        .ok_or("回退路径无效。")?
        .join(unique(".markwrite-rollback"));
    let result = (|| {
        write_new(&temp, before)?;
        fs::set_permissions(
            &temp,
            fs::metadata(path).map_err(|e| e.to_string())?.permissions(),
        )
        .map_err(|e| e.to_string())?;
        no_links(path)?;
        if fs::read(path).map_err(|e| e.to_string())? != current {
            return Err("回退前文档再次更改，已保留外部内容。".into());
        }
        storage::replace_file(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn update_access(state: &AppState, from: &Path, to: &Path, data_dir: &Path) -> Result<(), String> {
    let mut access = state.access.lock().map_err(|e| e.to_string())?;
    let old_files = access.files.clone();
    let old_roots = access.roots.clone();
    access.files = old_files
        .iter()
        .map(|path| rebase(path, from, to))
        .collect();
    access.roots = old_roots
        .iter()
        .map(|path| rebase(path, from, to))
        .collect();
    if let Err(error) = persist_access(data_dir, &access) {
        access.files = old_files;
        access.roots = old_roots;
        return Err(format!("无法保存移动后的访问权限：{error}"));
    }
    Ok(())
}

fn execute(
    state: &AppState,
    plan: Plan,
    history_root: &Path,
    data_dir: &Path,
) -> Result<ReferenceResult, String> {
    #[cfg(test)]
    let mut plan = plan;
    let journal = journal(&plan, history_root)?;
    let mut attempted = 0;
    let mut moved = false;
    let result = (|| {
        for (index, change) in plan.changes.iter().enumerate() {
            no_links(&change.path)?;
            attempted = index + 1;
            storage::atomic_write(
                &change.path,
                &change.after,
                Some(&storage::version(&change.before)),
                history_root,
            )?;
            #[cfg(test)]
            test_fault(&mut plan.fault, index + 1, &plan.to)?;
        }
        // Revalidate all selected documents before moving anything, including
        // the first file while later files were being written.
        for change in &plan.changes {
            no_links(&change.path)?;
            if storage::version(&fs::read(&change.path).map_err(|e| e.to_string())?)
                != change.result.version
            {
                return Err(format!(
                    "CONFLICT:写入期间文档被其他程序修改：{}",
                    change.path.display()
                ));
            }
        }
        no_links(&plan.from)?;
        no_links(plan.to.parent().ok_or("目标父目录无效。")?)?;
        storage::rename_without_replace(&plan.from, &plan.to)
            .map_err(|e| format!("无法移动；目标可能已存在或位于不同文件系统：{e}"))?;
        moved = true;
        update_access(state, &plan.from, &plan.to, data_dir)?;
        Ok(())
    })();
    if let Err(cause) = result {
        let mut failures = Vec::new();
        if moved {
            let back = (|| {
                no_links(&plan.to)?;
                if fs::metadata(&plan.to).map_err(|e| e.to_string())?.is_dir() != plan.directory {
                    return Err("移动目标已被外部替换，未覆盖。".to_owned());
                }
                storage::rename_without_replace(&plan.to, &plan.from).map_err(|e| e.to_string())
            })();
            match back {
                Ok(()) => moved = false,
                Err(error) => failures.push(format!("移动回退失败：{error}")),
            }
        }
        for change in plan.changes.iter().take(attempted).rev() {
            let path = if moved {
                &change.next_path
            } else {
                &change.path
            };
            if let Err(error) = restore_bytes(path, &change.before, &change.after) {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            let _ = fs::remove_dir_all(&journal);
            return Err(format!("{cause}\n本次移动和写入已回退。"));
        }
        return Err(format!(
            "{cause}\n部分回退未完成：{}\n原始副本与路径记录保留在：{}",
            failures.join("；"),
            journal.display()
        ));
    }
    let mut warnings = Vec::new();
    for old in &plan.moved_documents {
        if let Err(error) = history::relocate(history_root, old, &rebase(old, &plan.from, &plan.to))
        {
            warnings.push(format!(
                "文档已移动，但历史迁移未完成（原历史仍保留在 {}）：{}：{error}",
                history_root.display(),
                old.display()
            ));
        }
    }
    if let Err(error) = fs::remove_dir_all(&journal) {
        warnings.push(format!("移动已完成，临时恢复记录未能清理：{error}"));
    }
    Ok(ReferenceResult {
        path: plan.to.to_string_lossy().into_owned(),
        files: plan
            .changes
            .into_iter()
            .map(|change| change.result)
            .collect(),
        warnings,
    })
}

#[tauri::command]
pub async fn apply_reference_changes(
    root: Option<String>,
    from: String,
    to: String,
    changes: Vec<ReferenceChange>,
    app: tauri::AppHandle,
) -> Result<ReferenceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.writes.lock().map_err(|e| e.to_string())?;
        let plan = prepare(
            &state,
            root.as_deref(),
            Path::new(&from),
            Path::new(&to),
            changes,
        )?;
        let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        execute(&state, plan, &recovery(&app)?, &data_dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn choose_move_destination(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let source = canonical_existing(Path::new(&path))?;
    state.check(&source)?;
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Move to folder / 选择移动目标文件夹")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let parent = canonical_existing(&chosen.into_path().map_err(|e| e.to_string())?)?;
    if !parent.is_dir() {
        return Err("请选择目标文件夹。".into());
    }
    let name = source.file_name().ok_or("源文件名称无效。")?;
    let target = parent.join(name);
    if source == target {
        return Err("目标位置与原位置相同。".into());
    }
    if source.is_dir() && target.starts_with(&source) {
        return Err("不能将目录移入其自身或子目录。".into());
    }
    absent(&target)?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let mut access = state.access.lock().map_err(|e| e.to_string())?;
    let added = access.roots.insert(parent.clone());
    if let Err(error) = persist_access(&data_dir, &access) {
        if added {
            access.roots.remove(&parent);
        }
        return Err(error);
    }
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
enum Fault {
    Fail(usize),
    Destination(usize),
    External(usize, PathBuf),
}
#[cfg(test)]
fn test_fault(fault: &mut Option<Fault>, count: usize, target: &Path) -> Result<(), String> {
    let hits = matches!(fault, Some(Fault::Fail(at) | Fault::Destination(at) | Fault::External(at, _)) if *at == count);
    if !hits {
        return Ok(());
    }
    match fault.take().unwrap() {
        Fault::Fail(_) => Err("injected write failure".into()),
        Fault::Destination(_) => fs::write(target, b"concurrent target").map_err(|e| e.to_string()),
        Fault::External(_, path) => {
            fs::write(path, b"external content").unwrap();
            Err("injected conflict".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sandbox {
        base: PathBuf,
        root: PathBuf,
        destination: PathBuf,
        state: AppState,
    }
    impl Sandbox {
        fn new() -> Self {
            let base = std::env::temp_dir().join(unique("markwrite-reference-tests"));
            let root = base.join("notes");
            let destination = base.join("destination");
            fs::create_dir_all(&root).unwrap();
            fs::create_dir(&destination).unwrap();
            // Picker grants contain canonical paths, including Windows verbatim prefixes.
            let base = fs::canonicalize(base).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let destination = fs::canonicalize(destination).unwrap();
            let state = AppState::default();
            state
                .access
                .lock()
                .unwrap()
                .roots
                .extend([root.clone(), destination.clone()]);
            Self {
                base,
                root,
                destination,
                state,
            }
        }
        fn history(&self) -> PathBuf {
            self.base.join("history")
        }
        fn data(&self) -> PathBuf {
            self.base.join("data")
        }
        fn file(&self, name: &str, content: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, content).unwrap();
            path
        }
        fn change(&self, path: &Path, next: &Path, after: &str) -> ReferenceChange {
            let disk = storage::read(path).unwrap();
            ReferenceChange {
                path: path.to_string_lossy().into_owned(),
                next_path: next.to_string_lossy().into_owned(),
                before: disk.content,
                after: after.into(),
                expected_version: disk.version,
            }
        }
        fn plan(
            &self,
            from: &Path,
            to: &Path,
            changes: Vec<ReferenceChange>,
        ) -> Result<Plan, String> {
            prepare(&self.state, None, from, to, changes)
        }
        fn execute(&self, plan: Plan) -> Result<ReferenceResult, String> {
            execute(&self.state, plan, &self.history(), &self.data())
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn moves_selected_documents_preserving_bom_crlf_and_history() {
        let s = Sandbox::new();
        let from = s.file("原文.md", "\u{feff}# 原文\r\n[图](image.png)\r\n");
        let to = s.destination.join("原文.md");
        let linked = s.file("链接.md", "[旧](原文.md)\n");
        let untouched = s.file("未选中.md", "[旧](原文.md)\n");
        history::snapshot(&s.history(), &from, b"old history").unwrap();
        let result = s
            .execute(
                s.plan(
                    &from,
                    &to,
                    vec![
                        s.change(&from, &to, "# 原文\n[图](../notes/image.png)\n"),
                        s.change(&linked, &linked, "[旧](../destination/原文.md)\n"),
                    ],
                )
                .unwrap(),
            )
            .unwrap();
        assert!(!from.exists());
        assert_eq!(
            fs::read_to_string(&to).unwrap(),
            "\u{feff}# 原文\r\n[图](../notes/image.png)\r\n"
        );
        assert_eq!(fs::read_to_string(&untouched).unwrap(), "[旧](原文.md)\n");
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].path, to.to_string_lossy());
        assert_eq!(
            result.files[0].version,
            storage::version(&fs::read(&to).unwrap())
        );
        assert!(result.warnings.is_empty());
        assert_eq!(history::list(&s.history(), &to).unwrap().len(), 2);
        assert!(s.state.check(&to).is_ok());
    }
    #[test]
    fn directory_move_rebases_only_selected_files_and_access_roots() {
        let s = Sandbox::new();
        let from = s.root.join("chapter");
        fs::create_dir(&from).unwrap();
        let inner = from.join("inner.md");
        fs::write(&inner, "[a](../a.md)\n").unwrap();
        let other = from.join("other.md");
        fs::write(&other, "not selected").unwrap();
        s.state.access.lock().unwrap().roots.insert(from.clone());
        s.state.access.lock().unwrap().files.insert(inner.clone());
        let to = s.destination.join("chapter");
        let result = s
            .execute(
                s.plan(
                    &from,
                    &to,
                    vec![s.change(&inner, &to.join("inner.md"), "[a](../../notes/a.md)\n")],
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(
            fs::read_to_string(to.join("other.md")).unwrap(),
            "not selected"
        );
        let access = s.state.access.lock().unwrap();
        assert!(access.roots.contains(&to));
        assert!(access.files.contains(&to.join("inner.md")));
        assert!(!access.roots.contains(&from));
        assert!(!access.files.contains(&inner));
    }
    #[test]
    fn move_without_selected_reference_updates_keeps_contents_exact() {
        let s = Sandbox::new();
        let from = s.file("a.md", "[b](b.md)\n");
        let to = s.root.join("renamed.md");
        let result = s.execute(s.plan(&from, &to, vec![]).unwrap()).unwrap();
        assert!(result.files.is_empty());
        assert_eq!(fs::read_to_string(to).unwrap(), "[b](b.md)\n");
    }
    #[test]
    fn validates_all_versions_and_paths_before_any_write() {
        let s = Sandbox::new();
        let from = s.file("a.md", "one");
        let linked = s.file("b.md", "two");
        let to = s.root.join("c.md");
        let changes = vec![
            s.change(&from, &to, "changed"),
            s.change(&linked, &linked, "changed"),
        ];
        fs::write(&linked, "external").unwrap();
        assert!(s
            .plan(&from, &to, changes)
            .err()
            .expect("conflict")
            .starts_with("CONFLICT:"));
        assert_eq!(fs::read_to_string(from).unwrap(), "one");
        assert!(!to.exists());
    }
    #[test]
    fn rejects_existing_targets_outside_authority_and_wrong_rebased_paths() {
        let s = Sandbox::new();
        let from = s.file("a.md", "one");
        let exists = s.file("exists.md", "untouched");
        assert!(s.plan(&from, &exists, vec![]).is_err());
        let outside = s.base.join("unapproved");
        fs::create_dir(&outside).unwrap();
        assert!(s.plan(&from, &outside.join("a.md"), vec![]).is_err());
        let to = s.root.join("b.md");
        assert!(s
            .plan(
                &from,
                &to,
                vec![s.change(&from, &s.root.join("wrong.md"), "changed")]
            )
            .is_err());
        assert_eq!(fs::read_to_string(exists).unwrap(), "untouched");
    }
    #[test]
    fn rolls_back_written_contents_when_a_later_step_fails() {
        let s = Sandbox::new();
        let from = s.file("a.md", "\u{feff}original\r\n");
        let linked = s.file("b.md", "second");
        let to = s.root.join("moved.md");
        let mut plan = s
            .plan(
                &from,
                &to,
                vec![
                    s.change(&from, &to, "changed\n"),
                    s.change(&linked, &linked, "changed too"),
                ],
            )
            .unwrap();
        plan.fault = Some(Fault::Fail(2));
        assert!(s.execute(plan).err().expect("failure").contains("已回退"));
        assert_eq!(fs::read_to_string(from).unwrap(), "\u{feff}original\r\n");
        assert_eq!(fs::read_to_string(linked).unwrap(), "second");
        assert!(!to.exists());
    }
    #[test]
    fn concurrent_destination_is_never_overwritten_and_document_writes_roll_back() {
        let s = Sandbox::new();
        let from = s.file("a.md", "original");
        let to = s.root.join("moved.md");
        let mut plan = s
            .plan(&from, &to, vec![s.change(&from, &to, "changed")])
            .unwrap();
        plan.fault = Some(Fault::Destination(1));
        assert!(s.execute(plan).is_err());
        assert_eq!(fs::read_to_string(from).unwrap(), "original");
        assert_eq!(fs::read_to_string(to).unwrap(), "concurrent target");
    }
    #[test]
    fn rollback_preserves_external_edits_and_keeps_original_recovery_copies() {
        let s = Sandbox::new();
        let from = s.file("a.md", "original");
        let to = s.root.join("moved.md");
        let mut plan = s
            .plan(&from, &to, vec![s.change(&from, &to, "changed")])
            .unwrap();
        plan.fault = Some(Fault::External(1, from.clone()));
        let error = s.execute(plan).err().expect("conflict");
        assert!(error.contains("外部修改已保留"));
        assert!(error.contains("原始副本"));
        assert_eq!(fs::read_to_string(from).unwrap(), "external content");
        assert!(!to.exists());
        let journal = fs::read_dir(s.history())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("reference-transaction-")
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(journal.path().join("0.original")).unwrap(),
            "original"
        );
    }
    #[test]
    fn failed_access_persistence_rolls_back_move_and_content() {
        let s = Sandbox::new();
        let from = s.file("a.md", "original");
        let to = s.destination.join("a.md");
        fs::write(s.data(), "blocked").unwrap();
        let plan = s
            .plan(&from, &to, vec![s.change(&from, &to, "changed")])
            .unwrap();
        assert!(s.execute(plan).err().expect("failure").contains("访问权限"));
        assert_eq!(fs::read_to_string(from).unwrap(), "original");
        assert!(!to.exists());
    }
    #[test]
    fn history_migration_failure_is_reported_without_losing_original_history() {
        let s = Sandbox::new();
        let from = s.file("a.md", "original");
        let to = s.destination.join("a.md");
        history::snapshot(&s.history(), &from, b"earlier").unwrap();
        fs::write(
            s.history()
                .join(storage::version(to.to_string_lossy().as_bytes())),
            "blocked",
        )
        .unwrap();
        let result = s.execute(s.plan(&from, &to, vec![]).unwrap()).unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(to.exists());
        assert_eq!(history::list(&s.history(), &from).unwrap().len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_sources_targets_and_directory_children() {
        let s = Sandbox::new();
        let from = s.file("a.md", "original");
        let link = s.root.join("link.md");
        std::os::unix::fs::symlink(&from, &link).unwrap();
        assert!(s.plan(&link, &s.root.join("moved.md"), vec![]).is_err());
        let target = s.root.join("dangling.md");
        std::os::unix::fs::symlink(s.root.join("missing"), &target).unwrap();
        assert!(s.plan(&from, &target, vec![]).is_err());
        let dir = s.root.join("dir");
        fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink(&from, dir.join("child.md")).unwrap();
        assert!(s.plan(&dir, &s.destination.join("dir"), vec![]).is_err());
    }
}
