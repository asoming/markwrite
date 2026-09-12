#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod backup;
mod clipboard;
mod credentials;
mod document_windows;
mod history;
mod imports;
mod native_settings;
mod portable_export;
mod reference_changes;
mod session;
mod storage;
mod text_encoding;
mod transfer;
mod updates;
mod workspace;
use base64::Engine;
use notify::Watcher;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Arc, Mutex},
};
use storage::DiskFile;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default, Serialize, Deserialize)]
struct Access {
    roots: HashSet<PathBuf>,
    files: HashSet<PathBuf>,
}
#[derive(Default)]
struct AppState {
    access: Mutex<Access>,
    writes: Mutex<()>,
    session_writes: Mutex<()>,
    search_generation: Arc<AtomicU64>,
    search_request: Mutex<Option<String>>,
    filename_generation: Arc<AtomicU64>,
    filename_request: Mutex<Option<String>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}
fn persist_access(directory: &Path, access: &Access) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec(access).map_err(|e| e.to_string())?;
    let temp = directory.join("access.json.tmp");
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    storage::replace_file(&temp, &directory.join("access.json")).map_err(|e| e.to_string())?;
    Ok(())
}
impl AppState {
    fn persist(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let access = self.access.lock().map_err(|e| e.to_string())?;
        persist_access(&directory, &access)
    }
    fn allow_file(&self, path: &Path) -> Result<PathBuf, String> {
        let p = path.canonicalize().map_err(|e| e.to_string())?;
        self.access
            .lock()
            .map_err(|e| e.to_string())?
            .files
            .insert(p.clone());
        Ok(p)
    }
    fn check(&self, path: &Path) -> Result<PathBuf, String> {
        let p = path
            .canonicalize()
            .map_err(|e| format!("文件无法访问：{e}"))?;
        let a = self.access.lock().map_err(|e| e.to_string())?;
        if a.files.contains(&p) || a.roots.iter().any(|r| p.starts_with(r)) {
            Ok(p)
        } else {
            Err("请先从打开对话框选择该文件或文件夹。".into())
        }
    }
    fn check_directory(&self, path: &Path) -> Result<PathBuf, String> {
        let p = path.canonicalize().map_err(|e| e.to_string())?;
        let a = self.access.lock().map_err(|e| e.to_string())?;
        if a.roots.iter().any(|r| p.starts_with(r)) {
            Ok(p)
        } else {
            Err("请先打开这个文件夹。".into())
        }
    }
    fn parent_folder_at(
        &self,
        document_path: &Path,
        access_directory: &Path,
    ) -> Result<Folder, String> {
        self.parent_folder_mode(document_path, access_directory, false)
    }
    fn parent_folder_mode(
        &self,
        document_path: &Path,
        access_directory: &Path,
        shallow: bool,
    ) -> Result<Folder, String> {
        // The document must already be granted by the picker, OS open event, or a
        // workspace. Canonical paths retain Windows drive/UNC prefixes correctly.
        let document = self.check(document_path)?;
        if !document.is_file() || !is_markdown(&document) {
            return Err("只有已打开的 Markdown 文件可以显示其父文件夹。".into());
        }
        let parent = document
            .parent()
            .ok_or("这个文档没有可浏览的父文件夹。")?
            .to_path_buf();
        let entries = if shallow {
            scan_shallow(&parent)?
        } else {
            scan(&parent, 0, &mut 0)?
        };
        // Keep the grant and its durable record consistent. A failed scan or write
        // cannot grant a new root, and previously authorized folders remain intact.
        let mut access = self.access.lock().map_err(|e| e.to_string())?;
        let added = access.roots.insert(parent.clone());
        if let Err(error) = persist_access(access_directory, &access) {
            if added {
                access.roots.remove(&parent);
            }
            return Err(error);
        }
        Ok(Folder {
            path: parent.to_string_lossy().into_owned(),
            entries,
        })
    }
}
fn recovery(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery"))
}
fn valid_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&stem.as_str());
    if name.trim().is_empty()
        || name.chars().any(char::is_control)
        || name.contains(['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'])
        || name.ends_with([' ', '.'])
        || name == "."
        || name == ".."
        || reserved
    {
        Err("名称无效。".into())
    } else {
        Ok(())
    }
}
fn is_markdown(p: &Path) -> bool {
    p.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}
#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Entry>>,
}
fn scan(path: &Path, depth: usize, count: &mut usize) -> Result<Vec<Entry>, String> {
    if depth > 32 || *count > 100_000 {
        return Err("目录超过 32 层或 100,000 项，请打开更具体的工作文件夹。".into());
    }
    let mut entries = vec![];
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let kind = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if kind.is_symlink()
            || name.starts_with('.')
            || ["node_modules", "target"].contains(&name.as_str())
        {
            continue;
        }
        let p = item.path();
        if !kind.is_dir() && !is_markdown(&p) {
            continue;
        }
        *count += 1;
        let children = if kind.is_dir() {
            Some(scan(&p, depth + 1, count)?)
        } else {
            None
        };
        entries.push(Entry {
            name,
            path: p.to_string_lossy().into_owned(),
            directory: kind.is_dir(),
            children,
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
fn scan_shallow(path: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for (visited, item) in fs::read_dir(path).map_err(|e| e.to_string())?.enumerate() {
        if visited >= 100_000 {
            return Err(
                "当前目录超过 100,000 项，请选择更小的目录 / Folder exceeds 100,000 entries."
                    .into(),
            );
        }
        let item = item.map_err(|e| e.to_string())?;
        let kind = item.file_type().map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if kind.is_symlink()
            || name.starts_with('.')
            || ["node_modules", "target"].contains(&name.as_str())
        {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if item
                .metadata()
                .map_err(|e| e.to_string())?
                .file_attributes()
                & 0x400
                != 0
            {
                continue;
            }
        }
        let path = item.path();
        if !kind.is_dir() && !(kind.is_file() && is_markdown(&path)) {
            continue;
        }
        entries.push(Entry {
            name,
            path: path.to_string_lossy().into_owned(),
            directory: kind.is_dir(),
            children: None,
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}
#[tauri::command]
async fn choose_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DiskFile>, String> {
    let paths = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_files();
    let mut files = vec![];
    for path in paths.unwrap_or_default() {
        let p = path.into_path().map_err(|e| e.to_string())?;
        files.push(storage::read(&state.allow_file(&p)?)?);
    }
    state.persist(&app)?;
    Ok(files)
}
#[derive(Serialize)]
struct Folder {
    path: String,
    entries: Vec<Entry>,
}
#[tauri::command]
async fn choose_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    shallow: Option<bool>,
) -> Result<Option<Folder>, String> {
    let Some(path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    state
        .access
        .lock()
        .map_err(|e| e.to_string())?
        .roots
        .insert(path.clone());
    state.persist(&app)?;
    start_watcher(&app, &state, &path, false)?;
    Ok(Some(Folder {
        entries: if shallow.unwrap_or(false) {
            scan_shallow(&path)?
        } else {
            scan(&path, 0, &mut 0)?
        },
        path: path.to_string_lossy().into_owned(),
    }))
}
#[tauri::command]
async fn list_folder(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    scan(&state.check_directory(Path::new(&path))?, 0, &mut 0)
}
#[tauri::command]
async fn list_folder_shallow(path: String, app: tauri::AppHandle) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        scan_shallow(&app.state::<AppState>().check_directory(Path::new(&path))?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn parent_folder_shallow(
    document_path: String,
    app: tauri::AppHandle,
) -> Result<Folder, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        app.state::<AppState>()
            .parent_folder_mode(Path::new(&document_path), &directory, true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn parent_folder(document_path: String, app: tauri::AppHandle) -> Result<Folder, String> {
    // Scanning a large sibling tree must not occupy the async command executor.
    // The caller starts watching only after choosing this result as the visible root.
    tauri::async_runtime::spawn_blocking(move || {
        let access_directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        app.state::<AppState>()
            .parent_folder_at(Path::new(&document_path), &access_directory)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_document(
    path: String,
    state: State<'_, AppState>,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<DiskFile, String> {
    let path = state.check(Path::new(&path))?;
    match encoding {
        Some(encoding) => text_encoding::read(&path, encoding),
        None => storage::read(&path),
    }
}
#[tauri::command]
async fn save_document(
    file: DiskFile,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    encoding: Option<text_encoding::TextEncoding>,
) -> Result<DiskFile, String> {
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    let p = state.check(Path::new(&file.path))?;
    storage::atomic_write(
        &p,
        &text_encoding::serialize(&file, encoding.unwrap_or_default())?,
        Some(&file.version),
        &recovery(&app)?,
    )?;
    text_encoding::read(&p, encoding.unwrap_or_default())
}
#[tauri::command]
async fn save_as(
    content: String,
    name: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    encoding: Option<text_encoding::TextEncoding>,
    bom: Option<bool>,
    crlf: Option<bool>,
) -> Result<Option<DiskFile>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("Markdown", &["md"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let p = path.into_path().map_err(|e| e.to_string())?;
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    let encoding = encoding.unwrap_or_default();
    let bytes = text_encoding::serialize(
        &DiskFile {
            path: p.to_string_lossy().into_owned(),
            content,
            version: String::new(),
            bom: bom.unwrap_or(false),
            crlf: crlf.unwrap_or(false),
        },
        encoding,
    )?;
    storage::atomic_write(&p, &bytes, None, &recovery(&app)?)?;
    let file = text_encoding::read(&state.allow_file(&p)?, encoding)?;
    state.persist(&app)?;
    Ok(Some(file))
}
#[tauri::command]
async fn create_entry(
    parent: String,
    name: String,
    directory: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    valid_name(&name)?;
    let p = state.check_directory(Path::new(&parent))?.join(name);
    if directory {
        fs::create_dir(&p).map_err(|e| e.to_string())?;
    } else {
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&p)
            .map_err(|e| e.to_string())?;
    }
    Ok(p.to_string_lossy().into_owned())
}
#[tauri::command]
async fn rename_document(
    path: String,
    name: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    valid_name(&name)?;
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    let p = state.check(Path::new(&path))?;
    if state
        .access
        .lock()
        .map_err(|e| e.to_string())?
        .roots
        .contains(&p)
    {
        return Err("请在系统文件管理器重命名工作文件夹本身，然后重新打开。".into());
    }
    let dest = p.parent().ok_or("路径无效")?.join(name);
    if dest.symlink_metadata().is_ok() {
        return Err("同名文件已存在。".into());
    }
    fn document_paths(path: &Path) -> Result<Vec<PathBuf>, String> {
        if path.is_file() {
            return Ok(vec![path.to_path_buf()]);
        }
        fn flatten(entries: Vec<Entry>, files: &mut Vec<PathBuf>) {
            for entry in entries {
                if let Some(children) = entry.children {
                    flatten(children, files);
                } else {
                    files.push(PathBuf::from(entry.path));
                }
            }
        }
        let mut files = vec![];
        flatten(scan(path, 0, &mut 0)?, &mut files);
        Ok(files)
    }
    let renamed_documents = document_paths(&p)?;
    storage::rename_without_replace(&p, &dest)
        .map_err(|e| format!("无法重命名（目标可能已存在）：{e}"))?;
    {
        let mut access = state.access.lock().map_err(|e| e.to_string())?;
        access.files = access
            .files
            .iter()
            .map(|file| {
                file.strip_prefix(&p)
                    .map(|suffix| dest.join(suffix))
                    .unwrap_or_else(|_| file.clone())
            })
            .collect();
        access.files.insert(dest.clone());
    }
    for old in renamed_documents {
        let suffix = old.strip_prefix(&p).map_err(|e| e.to_string())?;
        let new = if suffix.as_os_str().is_empty() {
            dest.clone()
        } else {
            dest.join(suffix)
        };
        if let Err(error) = history::relocate(&recovery(&app)?, &old, &new) {
            let _ = app.emit(
                "document-open-error",
                format!("名称已更新，但部分历史迁移失败：{error}"),
            );
        }
    }
    state.persist(&app)?;
    Ok(dest.to_string_lossy().into_owned())
}
fn image_type(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "avif" => Ok("image/avif"),
        _ => Err("仅支持 PNG、JPEG、GIF、WebP、AVIF 图片。".into()),
    }
}
fn local_asset_reference(asset: &str) -> Result<String, String> {
    let decoded = percent_encoding::percent_decode_str(asset)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    // Reject URL, device and UNC references before canonicalize can contact a network share.
    // Relative references on a user-selected network document remain in that selected context.
    if decoded.is_empty()
        || decoded.chars().any(char::is_control)
        || decoded.contains(':')
        || decoded.starts_with("//")
        || decoded.starts_with('\\')
        || decoded.starts_with("/\\")
    {
        return Err("仅可读取文档目录或已打开工作文件夹中的本地图片。".into());
    }
    Ok(decoded.into_owned())
}
fn read_scoped_asset(
    document_path: &Path,
    asset: &str,
    state: &AppState,
) -> Result<String, String> {
    use std::io::Read;
    let decoded = local_asset_reference(asset)?;
    let doc = state.check(document_path)?;
    let parent = doc.parent().ok_or("文档目录无效")?;
    let p = parent
        .join(decoded)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let access = state.access.lock().map_err(|e| e.to_string())?;
    if !p.starts_with(parent) && !access.roots.iter().any(|r| p.starts_with(r)) {
        return Err("图片位于尚未打开的目录。".into());
    }
    let mime = image_type(&p)?;
    drop(access);
    let file = fs::File::open(p).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 {
        return Err("图片超过 20MB。".into());
    }
    let mut bytes = Vec::new();
    file.take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("图片超过 20MB。".into());
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
async fn read_asset(
    document_path: String,
    asset: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    read_scoped_asset(Path::new(&document_path), &asset, &state)
}
#[tauri::command]
async fn attach_image(
    path: String,
    name: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("图片超过 20MB。".into());
    }
    let doc = state.check(Path::new(&path))?;
    let mime = image_type(Path::new(&name))?;
    let ext = mime.strip_prefix("image/").unwrap();
    let dir = doc.parent().ok_or("目录无效")?.join("assets");
    if dir
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("附件目录不能是符号链接。".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = format!("image-{}.{}", storage::version(&bytes), ext);
    let target = dir.join(&file);
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
    {
        Ok(mut f) => {
            use std::io::Write;
            if let Err(e) = f.write_all(&bytes).and_then(|_| f.sync_all()) {
                let _ = fs::remove_file(&target);
                return Err(e.to_string());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    Ok(format!("assets/{file}"))
}
#[tauri::command]
async fn export_html(html: String, name: String, app: tauri::AppHandle) -> Result<bool, String> {
    let Some(p) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("HTML", &["html"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    storage::atomic_write(
        &p.into_path().map_err(|e| e.to_string())?,
        html.as_bytes(),
        None,
        &recovery(&app)?,
    )?;
    Ok(true)
}
#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("只支持 HTTP 和 HTTPS 链接。".into());
    }
    open::that_detached(url).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn initial_documents(app: tauri::AppHandle) -> Result<Vec<DiskFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut result = vec![];
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        for p in document_windows::document_arguments(&std::env::args().collect::<Vec<_>>(), &cwd) {
            if p.is_file() && is_markdown(&p) {
                let p = state.allow_file(&p)?;
                state.persist(&app)?;
                result.push(storage::read(&p)?);
            }
        }
        state.persist(&app)?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Clone, Serialize)]
struct WorkspaceChange {
    paths: Vec<String>,
}
fn start_watcher(
    app: &tauri::AppHandle,
    state: &AppState,
    path: &Path,
    recursive: bool,
) -> Result<(), String> {
    let app = app.clone();
    let root = path.to_path_buf();
    let mut watcher =
        notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let paths: Vec<String> = event
                    .paths
                    .into_iter()
                    .filter(|p| {
                        p.starts_with(&root)
                            && !p.strip_prefix(&root).unwrap_or(p).components().any(|c| {
                                let part = c.as_os_str().to_string_lossy();
                                part.starts_with('.') || part == "node_modules" || part == "target"
                            })
                    })
                    .map(|p| p.to_string_lossy().into_owned())
                    .take(1000)
                    .collect();
                if !paths.is_empty() {
                    let _ = app.emit("workspace-changed", WorkspaceChange { paths });
                }
            }
        })
        .map_err(|e| format!("无法监听文件夹：{e}"))?;
    watcher
        .watch(
            path,
            if recursive {
                notify::RecursiveMode::Recursive
            } else {
                notify::RecursiveMode::NonRecursive
            },
        )
        .map_err(|e| e.to_string())?;
    *state.watcher.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}
#[tauri::command]
async fn watch_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    recursive: Option<bool>,
) -> Result<(), String> {
    let path = state.check_directory(Path::new(&path))?;
    start_watcher(&app, &state, &path, recursive.unwrap_or(false))
}
#[tauri::command]
async fn save_export(
    name: String,
    extension: String,
    bytes: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    if !["pdf", "docx", "css"].contains(&extension.as_str()) {
        return Err("导出类型无效。".into());
    }
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("导出文件超过 100MB。".into());
    }
    let safe_name = name.rsplit(['/', '\\']).next().unwrap_or("文档");
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(safe_name)
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    storage::atomic_write(
        &path.into_path().map_err(|e| e.to_string())?,
        &bytes,
        None,
        &recovery(&app)?,
    )?;
    Ok(true)
}
fn accept_documents(app: &tauri::AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    let state = app.state::<AppState>();
    let mut files = vec![];
    for path in paths {
        if path.is_file() && is_markdown(&path) {
            match state.allow_file(&path).and_then(|p| storage::read(&p)) {
                Ok(file) => files.push(file),
                Err(error) => {
                    let _ = app.emit("document-open-error", error);
                }
            }
        }
    }
    if !files.is_empty() {
        let _ = state.persist(app);
        let _ = app.emit("open-documents", files);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn main() {
    let mut context = tauri::generate_context!();
    if let Err(error) = document_windows::configure(&mut context) {
        eprintln!("{error}");
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            accept_documents(
                app,
                document_windows::document_arguments(&args, Path::new(&cwd)),
            );
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                accept_documents(window.app_handle(), paths.clone());
            }
        })
        .manage(AppState::default())
        .manage(updates::UpdateState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            storage::configure_lock_directory(
                document_windows::shared_directory(app.handle())?.join("document-locks"),
            );
            let path = app.path().app_local_data_dir()?.join("access.json");
            if let Ok(data) = fs::read(&path) {
                if let Ok(access) = serde_json::from_slice::<Access>(&data) {
                    *app.state::<AppState>().access.lock().unwrap() = access;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            choose_files,
            document_windows::new_document_window,
            document_windows::reopen_document_window,
            document_windows::list_document_windows,
            document_windows::window_context,
            imports::choose_import_files,
            native_settings::default_markdown_status,
            native_settings::request_markdown_default,
            choose_folder,
            list_folder,
            list_folder_shallow,
            parent_folder,
            parent_folder_shallow,
            text_encoding::read_with_encoding,
            text_encoding::document_stamp,
            portable_export::prepare_portable,
            portable_export::save_portable,
            portable_export::discard_portable,
            portable_export::authorize_asset_folder,
            text_encoding::choose_file_for_encoding,
            read_document,
            save_document,
            save_as,
            create_entry,
            rename_document,
            workspace::search_folder,
            workspace::cancel_search,
            workspace::find_files,
            workspace::cancel_find_files,
            backup::backup_config,
            backup::backup_pick_destination,
            backup::backup_update_schedule,
            backup::backup_create,
            backup::backup_list,
            backup::backup_pick_snapshot,
            backup::backup_inspect,
            backup::backup_restore,
            updates::check_app_update,
            updates::download_app_update,
            updates::open_update_folder,
            updates::install_app_update,
            reference_changes::apply_reference_changes,
            reference_changes::choose_move_destination,
            reference_changes::reference_recovery_list,
            reference_changes::reference_recover,
            reference_changes::reference_recovery_archive,
            reference_changes::reference_recovery_reveal,
            workspace::workspace_documents,
            workspace::history_list,
            workspace::history_read,
            workspace::trash_entries,
            workspace::attachment_inventory,
            workspace::git_status,
            workspace::git_diff,
            workspace::git_init,
            workspace::git_commit,
            workspace::git_mark_resolved,
            workspace::git_conflict_versions,
            workspace::git_save_resolution,
            watch_folder,
            save_export,
            session::save_session,
            session::load_session,
            clipboard::read_clipboard_image,
            ai::ai_transform,
            ai::ai_test_connection,
            credentials::ai_load_key,
            credentials::ai_save_key,
            credentials::ai_delete_key,
            transfer::upload_image,
            transfer::publish_html,
            read_asset,
            attach_image,
            export_html,
            open_external,
            initial_documents
        ])
        .run(context)
        .expect("无法启动 Markwrite");
}

#[cfg(test)]
mod native_tests {
    use super::*;
    #[test]
    fn shallow_tree_never_reads_nested_directories() {
        let base = parent_fixture("shallow");
        let mut deep = base.join("notes/child");
        for _ in 0..40 {
            deep = deep.join("next");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("too-deep.md"), "nested").unwrap();
        fs::write(base.join("notes/file.txt"), "excluded").unwrap();
        let entries = scan_shallow(&base.join("notes")).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().all(|entry| entry.children.is_none()));
        assert!(entries[0].directory);
        assert!(scan(&base.join("notes"), 0, &mut 0).is_err());
        let state = AppState::default();
        let document = base.join("notes/文档.MD");
        state.allow_file(&document).unwrap();
        let folder = state
            .parent_folder_mode(&document, &base.join("settings"), true)
            .unwrap();
        assert_eq!(folder.entries.len(), 3);
        assert!(state.check_directory(&base.join("notes")).is_ok());
        assert!(state.check(&base.join("private.md")).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    fn parent_fixture(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "markwrite-parent-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(base.join("notes/child")).unwrap();
        fs::write(base.join("notes/文档.MD"), "# 文档").unwrap();
        fs::write(base.join("notes/sibling.md"), "sibling").unwrap();
        fs::write(base.join("notes/child/nested.markdown"), "nested").unwrap();
        fs::write(base.join("private.md"), "private").unwrap();
        base
    }
    #[test]
    fn parent_folder_grants_only_the_authorized_documents_canonical_parent() {
        let base = parent_fixture("scope");
        let document = base.join("notes/文档.MD");
        let state = AppState::default();
        state.allow_file(&document).unwrap();
        let parent = document
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(state.check_directory(&parent).is_err());
        let folder = state
            .parent_folder_at(&document, &base.join("settings"))
            .unwrap();
        assert_eq!(PathBuf::from(&folder.path), parent);
        assert_eq!(state.check_directory(&parent).unwrap(), parent);
        assert!(state.check(&base.join("notes/sibling.md")).is_ok());
        assert!(state.check_directory(&base).is_err());
        assert!(state.check(&base.join("private.md")).is_err());
        let child = folder
            .entries
            .iter()
            .find(|entry| entry.name == "child")
            .unwrap();
        assert!(child.directory);
        assert_eq!(child.children.as_ref().unwrap()[0].name, "nested.markdown");
        assert!(folder.entries.iter().any(|entry| entry.name == "文档.MD"));
        let persisted: Access =
            serde_json::from_slice(&fs::read(base.join("settings/access.json")).unwrap()).unwrap();
        assert_eq!(persisted.roots, HashSet::from([parent]));
        assert!(persisted.files.contains(&document.canonicalize().unwrap()));
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn parent_folder_cannot_promote_unopened_files_directories_or_non_markdown() {
        let base = parent_fixture("denied");
        let state = AppState::default();
        let settings = base.join("settings");
        assert!(state
            .parent_folder_at(&base.join("notes/文档.MD"), &settings)
            .is_err());
        fs::write(base.join("notes/file.txt"), "text").unwrap();
        state.allow_file(&base.join("notes/file.txt")).unwrap();
        assert!(state
            .parent_folder_at(&base.join("notes/file.txt"), &settings)
            .is_err());
        fs::create_dir(base.join("notes/folder.md")).unwrap();
        state.allow_file(&base.join("notes/folder.md")).unwrap();
        assert!(state
            .parent_folder_at(&base.join("notes/folder.md"), &settings)
            .is_err());
        assert!(state.access.lock().unwrap().roots.is_empty());
        assert!(!settings.exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn parent_folder_persistence_failure_rolls_back_only_the_new_grant() {
        let base = parent_fixture("rollback");
        let document = base.join("notes/文档.MD");
        let parent = document
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let blocked_settings = base.join("not-a-directory");
        fs::write(&blocked_settings, "preserve").unwrap();
        let state = AppState::default();
        state.allow_file(&document).unwrap();
        assert!(state
            .parent_folder_at(&document, &blocked_settings)
            .is_err());
        assert!(state.check_directory(&parent).is_err());
        assert!(state.check(&document).is_ok());
        assert!(state.check(&base.join("notes/sibling.md")).is_err());
        state.access.lock().unwrap().roots.insert(parent.clone());
        assert!(state
            .parent_folder_at(&document, &blocked_settings)
            .is_err());
        assert_eq!(state.check_directory(&parent).unwrap(), parent);
        assert_eq!(fs::read_to_string(blocked_settings).unwrap(), "preserve");
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn parent_folder_failed_scan_does_not_grant_or_persist_access() {
        let base = parent_fixture("scan-limit");
        let mut descendant = base.join("notes/deep");
        for _ in 0..34 {
            fs::create_dir_all(&descendant).unwrap();
            descendant = descendant.join("level");
        }
        let state = AppState::default();
        let document = base.join("notes/文档.MD");
        state.allow_file(&document).unwrap();
        assert!(state
            .parent_folder_at(&document, &base.join("settings"))
            .is_err());
        assert!(state.access.lock().unwrap().roots.is_empty());
        assert!(!base.join("settings/access.json").exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn parent_folder_scan_skips_symlinks_and_does_not_grant_their_targets() {
        let base = parent_fixture("symlink");
        let document = base.join("notes/文档.MD");
        std::os::unix::fs::symlink(base.join("private.md"), base.join("notes/link.md")).unwrap();
        std::os::unix::fs::symlink(&base, base.join("notes/ancestor")).unwrap();
        let state = AppState::default();
        state.allow_file(&document).unwrap();
        let folder = state
            .parent_folder_at(&document, &base.join("settings"))
            .unwrap();
        assert!(!folder
            .entries
            .iter()
            .any(|entry| ["link.md", "ancestor"].contains(&entry.name.as_str())));
        assert!(state.check(&base.join("notes/link.md")).is_err());
        assert!(state.check_directory(&base.join("notes/ancestor")).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn filenames_are_portable_and_cannot_escape_the_parent() {
        for name in [
            "../secret",
            "..",
            "note/part",
            "note\\part",
            "CON.md",
            "lpt1.txt",
            "bad:name.md",
            "trailing.",
            "bad\nname.md",
        ] {
            assert!(valid_name(name).is_err(), "{name:?}");
        }
        assert!(valid_name("中文 笔记.md").is_ok());
    }
    #[test]
    fn scopes_do_not_follow_symlinks_outside_authorized_root() {
        let base = std::env::temp_dir().join(format!(
            "markwrite-scope-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(base.join("allowed")).unwrap();
        fs::write(base.join("private.md"), "secret").unwrap();
        let state = AppState::default();
        state
            .access
            .lock()
            .unwrap()
            .roots
            .insert(base.join("allowed").canonicalize().unwrap());
        assert!(state.check(&base.join("private.md")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("private.md"), base.join("allowed/link.md"))
                .unwrap();
            assert!(state.check(&base.join("allowed/link.md")).is_err());
        }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn asset_references_reject_network_and_device_paths_before_io() {
        for reference in [
            "//server/share/private.png",
            r"\\server\share\private.png",
            r"\\?\C:\private.png",
            "%5c%5cserver/share/private.png",
            "%2f%2fserver/share/private.png",
            "https%3a//example.com/image.png",
            "file:///etc/private.png",
            r"C:\private.png",
            "image.png:stream",
        ] {
            assert!(local_asset_reference(reference).is_err(), "{reference}");
        }
        assert_eq!(
            local_asset_reference("assets/a%20b.png").unwrap(),
            "assets/a b.png"
        );
    }
    #[test]
    fn html_image_scope_is_its_directory_or_an_explicit_workspace() {
        let base = std::env::temp_dir().join(format!(
            "markwrite-html-scope-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let document = base.join("selected/document.html");
        fs::create_dir_all(document.parent().unwrap().join("assets")).unwrap();
        fs::create_dir_all(base.join("workspace")).unwrap();
        fs::write(&document, "<img src='assets/a b.png'>").unwrap();
        fs::write(base.join("selected/assets/a b.png"), b"PNG").unwrap();
        fs::write(base.join("private.png"), b"private").unwrap();
        fs::write(base.join("workspace/shared.png"), b"shared").unwrap();
        let state = AppState::default();
        assert!(read_scoped_asset(&document, "assets/a%20b.png", &state).is_err());
        state.allow_file(&document).unwrap();
        assert!(read_scoped_asset(&document, "assets/a%20b.png", &state).is_ok());
        assert!(read_scoped_asset(&document, "../private.png", &state).is_err());
        assert!(read_scoped_asset(&document, "../workspace/shared.png", &state).is_err());
        state
            .access
            .lock()
            .unwrap()
            .roots
            .insert(base.join("workspace").canonicalize().unwrap());
        assert!(read_scoped_asset(&document, "../workspace/shared.png", &state).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("private.png"), base.join("selected/link.png"))
                .unwrap();
            assert!(read_scoped_asset(&document, "link.png", &state).is_err());
        }
        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            "<img src='assets/a b.png'>"
        );
        fs::remove_dir_all(base).unwrap();
    }
}
