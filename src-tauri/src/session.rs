//! Desktop drafts are kept outside WebView localStorage quotas. Both generations are
//! application-owned, atomically replaced JSON files, independent from document history.
use crate::{storage, AppState};
use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
const MAX_SESSION_BYTES: u64 = 256 * 1024 * 1024;
fn validate(json: &str) -> Result<(), String> {
    if json.len() as u64 > MAX_SESSION_BYTES {
        return Err("恢复会话超过 256MB，请先保存文档并关闭部分标签。".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "会话数据无效，原恢复副本已保留。")?;
    let docs = value
        .get("docs")
        .and_then(|d| d.as_array())
        .ok_or("会话缺少文档列表，原恢复副本已保留。")?;
    if docs.iter().any(|d| {
        !d.get("id").is_some_and(|v| v.is_string())
            || !d.get("content").is_some_and(|v| v.is_string())
    }) {
        return Err("恢复文档格式无效，原恢复副本已保留。".into());
    }
    Ok(())
}
fn read_valid(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() || metadata.len() > MAX_SESSION_BYTES {
        return Err("会话文件类型无效或超过 256MB。".into());
    }
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    validate(&json)?;
    Ok(Some(json))
}
pub fn load(directory: &Path) -> Result<Option<String>, String> {
    match read_valid(&directory.join("session.json")) {
        Ok(Some(json)) => Ok(Some(json)),
        Ok(None) => read_valid(&directory.join("session.previous.json")),
        Err(primary_error) => match read_valid(&directory.join("session.previous.json")) {
            Ok(Some(json)) => Ok(Some(json)),
            _ => Err(format!(
                "无法读取草稿恢复文件：{primary_error}。现有副本保留在应用数据目录。"
            )),
        },
    }
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("恢复目录无效。")?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(".session-{}-{stamp}.tmp", std::process::id()));
    let operation = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        storage::replace_file(&temp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            fs::File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(temp);
    }
    operation
}
pub fn save(directory: &Path, json: &str) -> Result<(), String> {
    validate(json)?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let path = directory.join("session.json");
    if let Ok(Some(previous)) = read_valid(&path) {
        if previous == json {
            return Ok(());
        }
        write_atomic(
            &directory.join("session.previous.json"),
            previous.as_bytes(),
        )
        .map_err(|e| format!("无法保留上一份恢复副本：{e}"))?;
    }
    write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("草稿恢复保存失败：{e}。请保存文档后重试。"))
}
#[tauri::command]
pub async fn save_session(json: String, app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.session_writes.lock().map_err(|e| e.to_string())?;
        save(
            &app.path().app_local_data_dir().map_err(|e| e.to_string())?,
            &json,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.session_writes.lock().map_err(|e| e.to_string())?;
        load(&app.path().app_local_data_dir().map_err(|e| e.to_string())?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "markwrite-session-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
    fn fixture(text: &str) -> String {
        serde_json::json!({"docs":[{"id":"a","content":text,"saved":""}],"settings":{}}).to_string()
    }
    #[test]
    fn large_drafts_roundtrip_and_corruption_falls_back() {
        let root = root("large");
        let first = fixture(&"文".repeat(2_000_000));
        let second = fixture("new");
        save(&root, &first).unwrap();
        assert_eq!(load(&root).unwrap(), Some(first.clone()));
        save(&root, &second).unwrap();
        fs::write(root.join("session.json"), "truncated{").unwrap();
        assert_eq!(load(&root).unwrap(), Some(first));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_data_and_failed_backup_preserve_original() {
        let root = root("failure");
        let original = fixture("original");
        save(&root, &original).unwrap();
        assert!(save(&root, "{bad").is_err());
        assert_eq!(load(&root).unwrap(), Some(original.clone()));
        fs::create_dir(root.join("session.previous.json")).unwrap();
        assert!(save(&root, &fixture("changed")).is_err());
        assert_eq!(load(&root).unwrap(), Some(original));
        assert!(!fs::read_dir(&root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(root).unwrap();
    }
}
