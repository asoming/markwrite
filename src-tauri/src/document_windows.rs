//! Each explicit document window is a separately launched process with a stable
//! identifier, WebView store, access grants, and recovery directory of its own.
use crate::{storage, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub const BASE_IDENTIFIER: &str = "app.markwrite.desktop";
const FLAG: &str = "--markwrite-window";
const MAX_SETTINGS: usize = 256 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub id: String,
    pub path: Option<String>,
    pub created_at_ms: u64,
    #[serde(default)]
    pub has_session: bool,
}
#[derive(Serialize)]
pub struct WindowStarted {
    pub id: String,
    pub pid: u32,
}
#[derive(Serialize)]
pub struct WindowContext {
    pub id: Option<String>,
    pub pid: u32,
    pub isolated: bool,
    pub settings: Option<Value>,
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
pub fn identifier(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("窗口恢复标识无效 / Invalid window recovery identifier.".into());
    }
    Ok(format!("{BASE_IDENTIFIER}.window.w{id}"))
}
fn id_from_identifier(identifier: &str) -> Option<String> {
    identifier
        .strip_prefix(&format!("{BASE_IDENTIFIER}.window.w"))
        .filter(|id| valid_id(id))
        .map(str::to_owned)
}
pub fn startup_id(args: &[String]) -> Result<Option<String>, String> {
    let mut id = None;
    let mut args = args.iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--" {
            break;
        }
        if arg == FLAG {
            let value = args
                .next()
                .ok_or("缺少窗口恢复标识 / Missing window recovery identifier.")?;
            identifier(value)?;
            if id.replace(value.clone()).is_some() {
                return Err("重复的窗口参数 / Duplicate window identifier.".into());
            }
        }
    }
    Ok(id)
}
pub fn document_arguments(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut args = args.iter().skip(1);
    let mut flags = true;
    while let Some(arg) = args.next() {
        if flags && arg == "--" {
            flags = false;
            continue;
        }
        if flags && arg == FLAG {
            args.next();
            continue;
        }
        if flags && arg.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(arg);
        paths.push(if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        });
    }
    paths
}
pub fn configure<R: tauri::Runtime>(context: &mut tauri::Context<R>) -> Result<(), String> {
    if let Some(id) = startup_id(&std::env::args().collect::<Vec<_>>())? {
        context.config_mut().identifier = identifier(&id)?;
        // WKWebView needs a unique persistent data store rather than data_directory.
        let mut store = [0; 16];
        for (i, byte) in store.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
        }
        for window in &mut context.config_mut().app.windows {
            window.data_store_identifier = Some(store);
        }
    }
    Ok(())
}
pub fn shared_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .local_data_dir()
        .map_err(|e| e.to_string())?
        .join(BASE_IDENTIFIER))
}
fn profile_directory(shared: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(shared
        .parent()
        .ok_or("应用目录无效 / Invalid application directory.")?
        .join(identifier(id)?))
}
fn index_directory(shared: &Path) -> PathBuf {
    shared.join("document-windows")
}
fn private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn read_record(shared: &Path, id: &str) -> Result<WindowRecord, String> {
    identifier(id)?;
    let path = index_directory(shared).join(format!("{id}.json"));
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 16 * 1024 {
        return Err("窗口记录过大 / Window record is too large.".into());
    }
    let record: WindowRecord = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if record.id != id {
        return Err("窗口记录不匹配 / Window record does not match.".into());
    }
    Ok(record)
}
fn allocate(
    shared: &Path,
    path: Option<String>,
    settings: Option<Value>,
) -> Result<WindowRecord, String> {
    let settings = match settings {
        Some(value) => {
            if !value.is_object() {
                return Err("设置格式无效 / Invalid preferences.".into());
            }
            let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
            if bytes.len() > MAX_SETTINGS {
                return Err("设置超过 256 KiB / Preferences exceed 256 KiB.".into());
            }
            Some(bytes)
        }
        None => None,
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let id = storage::version(
        format!(
            "{}:{}:{}",
            std::process::id(),
            stamp.as_nanos(),
            NONCE.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    )[..32]
        .to_owned();
    let profile = profile_directory(shared, &id)?;
    private_directory(&index_directory(shared))?;
    // A fresh profile is created exactly once. Reopening never reseeds or truncates it.
    fs::create_dir(&profile).map_err(|e| e.to_string())?;
    private_directory(&profile)?;
    if let Some(settings) = settings {
        write_new(&profile.join("window-settings.json"), &settings)?;
    }
    let record = WindowRecord {
        id,
        path,
        created_at_ms: stamp.as_millis().min(u64::MAX as u128) as u64,
        has_session: false,
    };
    write_new(
        &index_directory(shared).join(format!("{}.json", record.id)),
        &serde_json::to_vec(&record).map_err(|e| e.to_string())?,
    )?;
    Ok(record)
}
fn spawn(record: &WindowRecord, open_original: bool) -> Result<WindowStarted, String> {
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.arg(FLAG).arg(&record.id).arg("--");
    if let Some(path) = record
        .path
        .as_ref()
        .filter(|path| open_original && Path::new(path).is_file())
    {
        command.arg(path);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: WebView still creates its GUI window.
    }
    let child = command
        .spawn()
        .map_err(|e| format!("无法打开独立窗口 / Could not start a document window: {e}"))?;
    // Dropping Child neither kills nor waits for the separately running GUI process.
    Ok(WindowStarted {
        id: record.id.clone(),
        pid: child.id(),
    })
}
#[tauri::command]
pub async fn new_document_window(
    path: Option<String>,
    settings: Option<Value>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<WindowStarted, String> {
    let path = path
        .map(|path| {
            state.check(Path::new(&path)).and_then(|path| {
                if !path.is_file() || !crate::is_markdown(&path) {
                    return Err("请选择 Markdown 文档 / Select a Markdown document.".into());
                }
                Ok(path.to_string_lossy().into_owned())
            })
        })
        .transpose()?;
    let record = allocate(&shared_directory(&app)?, path, settings)?;
    spawn(&record, true)
}
#[tauri::command]
pub async fn reopen_document_window(
    id: String,
    app: tauri::AppHandle,
) -> Result<WindowStarted, String> {
    let shared = shared_directory(&app)?;
    let record = read_record(&shared, &id)?;
    let profile = profile_directory(&shared, &id)?;
    let has_session =
        profile.join("session.json").is_file() || profile.join("session.previous.json").is_file();
    // Restore the window's active draft; a fresh file argument intentionally opens
    // a clean disk view and would otherwise add a duplicate tab on every recovery.
    spawn(&record, !has_session)
}
#[tauri::command]
pub async fn list_document_windows(app: tauri::AppHandle) -> Result<Vec<WindowRecord>, String> {
    let shared = shared_directory(&app)?;
    let directory = index_directory(&shared);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for item in fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .take(1000)
    {
        let item = item.map_err(|e| e.to_string())?;
        if !item.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let path = item.path();
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if let Ok(mut record) = read_record(&shared, id) {
            let profile = profile_directory(&shared, id)?;
            record.has_session = profile.join("session.json").is_file()
                || profile.join("session.previous.json").is_file();
            records.push(record);
        }
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.created_at_ms));
    Ok(records)
}
#[tauri::command]
pub async fn window_context(app: tauri::AppHandle) -> Result<WindowContext, String> {
    let id = id_from_identifier(&app.config().identifier);
    let settings = if id.is_some() {
        let path = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("window-settings.json");
        if path.is_file()
            && fs::metadata(&path).map_err(|e| e.to_string())?.len() <= MAX_SETTINGS as u64
        {
            Some(
                serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        }
    } else {
        None
    };
    Ok(WindowContext {
        isolated: id.is_some(),
        id,
        pid: std::process::id(),
        settings,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;
    #[test]
    fn validates_profiles_and_separates_document_arguments() {
        let id = "1234567890abcdef1234567890abcdef";
        let args = vec![
            "markwrite".into(),
            FLAG.into(),
            id.into(),
            "--".into(),
            "中文.md".into(),
        ];
        assert_eq!(startup_id(&args).unwrap().as_deref(), Some(id));
        assert_eq!(
            document_arguments(&args, Path::new("/notes")),
            vec![PathBuf::from("/notes/中文.md")]
        );
        assert_eq!(
            id_from_identifier(&identifier(id).unwrap()).as_deref(),
            Some(id)
        );
        assert!(identifier("../../notes").is_err());
        assert!(startup_id(&["markwrite".into(), FLAG.into()]).is_err());
    }
    #[test]
    fn independent_recovery_profiles_survive_each_others_writes() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-window-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let shared = root.join(BASE_IDENTIFIER);
        let a = allocate(
            &shared,
            Some("/notes/a.md".into()),
            Some(serde_json::json!({"language":"en"})),
        )
        .unwrap();
        let b = allocate(&shared, Some("/notes/b.md".into()), None).unwrap();
        let a_path = profile_directory(&shared, &a.id).unwrap();
        let b_path = profile_directory(&shared, &b.id).unwrap();
        let original = serde_json::json!({"docs":[{"id":"a","content":"unsaved A"}],"settings":{}})
            .to_string();
        let second = serde_json::json!({"docs":[{"id":"b","content":"unsaved B"}],"settings":{}})
            .to_string();
        session::save(&a_path, &original).unwrap();
        session::save(&b_path, &second).unwrap();
        assert_eq!(session::load(&a_path).unwrap(), Some(original));
        assert_eq!(session::load(&b_path).unwrap(), Some(second));
        assert!(!shared.join("session.json").exists());
        assert_eq!(read_record(&shared, &a.id).unwrap().id, a.id);
        assert_eq!(
            fs::read_to_string(a_path.join("window-settings.json")).unwrap(),
            "{\"language\":\"en\"}"
        );
        assert_ne!(a_path, b_path);
        fs::remove_dir_all(root).unwrap();
    }
}
