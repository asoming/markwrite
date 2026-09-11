#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod storage;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use storage::DiskFile;
use tauri::{Manager, State};
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
}
impl AppState {
    fn persist(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let access = self.access.lock().map_err(|e| e.to_string())?;
        let data = serde_json::to_vec(&*access).map_err(|e| e.to_string())?;
        let temp = directory.join("access.json.tmp");
        fs::write(&temp, data).map_err(|e| e.to_string())?;
        fs::rename(temp, directory.join("access.json")).map_err(|e| e.to_string())?;
        Ok(())
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
}
fn recovery(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery"))
}
fn valid_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
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
    if depth > 16 || *count > 20_000 {
        return Ok(vec![]);
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
    Ok(Some(Folder {
        entries: scan(&path, 0, &mut 0)?,
        path: path.to_string_lossy().into_owned(),
    }))
}
#[tauri::command]
async fn list_folder(path: String, state: State<'_, AppState>) -> Result<Vec<Entry>, String> {
    scan(&state.check_directory(Path::new(&path))?, 0, &mut 0)
}
#[tauri::command]
async fn read_document(path: String, state: State<'_, AppState>) -> Result<DiskFile, String> {
    storage::read(&state.check(Path::new(&path))?)
}
#[tauri::command]
async fn save_document(
    file: DiskFile,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DiskFile, String> {
    let _guard = state.writes.lock().map_err(|e| e.to_string())?;
    let p = state.check(Path::new(&file.path))?;
    storage::atomic_write(
        &p,
        &storage::serialize(&file),
        Some(&file.version),
        &recovery(&app)?,
    )?;
    storage::read(&p)
}
#[tauri::command]
async fn save_as(
    content: String,
    name: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
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
    storage::atomic_write(&p, content.as_bytes(), None, &recovery(&app)?)?;
    let file = storage::read(&state.allow_file(&p)?)?;
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
    let dest = p.parent().ok_or("路径无效")?.join(name);
    if dest.exists() {
        return Err("同名文件已存在。".into());
    }
    fs::rename(&p, &dest).map_err(|e| e.to_string())?;
    state.allow_file(&dest)?;
    state
        .access
        .lock()
        .map_err(|e| e.to_string())?
        .files
        .remove(&p);
    state.persist(&app)?;
    Ok(dest.to_string_lossy().into_owned())
}
#[derive(Serialize)]
struct Hit {
    path: String,
    line: usize,
    text: String,
}
fn search_entries(entries: Vec<Entry>, query: &str, hits: &mut Vec<Hit>) {
    for entry in entries {
        if hits.len() >= 500 {
            break;
        }
        if let Some(children) = entry.children {
            search_entries(children, query, hits);
        } else if let Ok(file) = storage::read(Path::new(&entry.path)) {
            for (i, line) in file.content.lines().enumerate() {
                if hits.len() >= 500 {
                    break;
                }
                if line.to_lowercase().contains(query) {
                    hits.push(Hit {
                        path: entry.path.clone(),
                        line: i + 1,
                        text: line.chars().take(240).collect(),
                    });
                }
            }
        }
    }
}
#[tauri::command]
async fn search_folder(
    path: String,
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<Hit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let p = state.check_directory(Path::new(&path))?;
    let mut hits = vec![];
    search_entries(scan(&p, 0, &mut 0)?, &query.to_lowercase(), &mut hits);
    Ok(hits)
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
#[tauri::command]
async fn read_asset(
    document_path: String,
    asset: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let doc = state.check(Path::new(&document_path))?;
    let parent = doc.parent().ok_or("文档目录无效")?;
    let decoded = percent_encoding::percent_decode_str(&asset)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    let p = parent
        .join(decoded.as_ref())
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let access = state.access.lock().map_err(|e| e.to_string())?;
    if !p.starts_with(parent) && !access.roots.iter().any(|r| p.starts_with(r)) {
        return Err("图片位于尚未打开的目录。".into());
    }
    let mime = image_type(&p)?;
    let size = fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if size > 20 * 1024 * 1024 {
        return Err("图片超过 20MB。".into());
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
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
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn initial_documents(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DiskFile>, String> {
    let mut result = vec![];
    for arg in std::env::args().skip(1) {
        let p = Path::new(&arg);
        if p.is_file() && is_markdown(p) {
            result.push(storage::read(&state.allow_file(p)?)?);
        }
    }
    state.persist(&app)?;
    Ok(result)
}
fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
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
            choose_folder,
            list_folder,
            read_document,
            save_document,
            save_as,
            create_entry,
            rename_document,
            search_folder,
            read_asset,
            attach_image,
            export_html,
            open_external,
            initial_documents
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Markwrite");
}
