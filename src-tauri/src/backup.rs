//! Versioned, bounded directory snapshots. Only user-selected destinations and
//! already-authorized workspaces are used; restore always creates a new folder.
use crate::{storage, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

static OPERATIONS: Mutex<()> = Mutex::new(());
static NONCE: AtomicU64 = AtomicU64::new(0);
const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_SETTINGS: u64 = 16 * 1024 * 1024;
#[derive(Clone, Copy)]
struct Limits {
    files: usize,
    file_bytes: u64,
    total_bytes: u64,
    visited: usize,
}
const LIMITS: Limits = Limits {
    files: 10_000,
    file_bytes: 32 * 1024 * 1024,
    total_bytes: 1024 * 1024 * 1024,
    visited: 100_000,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub destination: Option<String>,
    pub enabled: bool,
    pub interval_hours: u32,
    pub last_backup_at_ms: Option<u64>,
    pub next_backup_at_ms: Option<u64>,
    pub last_error: Option<String>,
}
impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            destination: None,
            enabled: false,
            interval_hours: 24,
            last_backup_at_ms: None,
            next_backup_at_ms: None,
            last_error: None,
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigRecord {
    #[serde(default)]
    config: BackupConfig,
    #[serde(default)]
    approved_snapshots: Vec<PathBuf>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    id: String,
    workspace_name: String,
    created_at_ms: u64,
    files: Vec<BackupFile>,
    settings: BackupFile,
    settings_included: bool,
    skipped_files: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub id: String,
    pub path: String,
    pub workspace_name: String,
    pub created_at_ms: u64,
    pub file_count: usize,
    pub markdown_count: usize,
    pub image_count: usize,
    pub total_bytes: u64,
    pub settings_included: bool,
    pub skipped_files: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspection {
    pub summary: BackupSummary,
    pub files: Vec<BackupFile>,
    pub settings_bundle: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestore {
    pub path: String,
    pub settings_bundle: Value,
    pub file_count: usize,
    pub total_bytes: u64,
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn unique_name(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        now_ms(),
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn next_due(config: &BackupConfig, time: u64) -> Option<u64> {
    config
        .enabled
        .then(|| time.saturating_add(config.interval_hours as u64 * 3_600_000))
}
fn io_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        } // reparse points, including junctions
    }
    metadata.file_type().is_symlink()
}
fn directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| io_error("目录无法访问 / Cannot access folder", e))?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("不能使用符号链接或非目录路径 / A real folder is required.".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}
fn portable_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4096 || value.contains('\\') || value.starts_with('/') {
        return Err("快照相对路径无效 / Invalid snapshot path.".into());
    }
    let path = Path::new(value);
    let mut count = 0;
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("快照路径不能越过根目录 / Snapshot path escapes its root.".into());
        };
        let name = name
            .to_str()
            .ok_or("快照名称须为 UTF-8 / Snapshot names must be UTF-8.")?;
        crate::valid_name(name)
            .map_err(|_| format!("文件名不兼容 Linux/Windows / Non-portable filename: {name}"))?;
        count += 1;
    }
    if count == 0
        || count > 33
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("快照相对路径无效 / Invalid snapshot path.".into());
    }
    Ok(path.to_path_buf())
}
fn checked_path(root: &Path, relative: &str, expected_directory: bool) -> Result<PathBuf, String> {
    let relative = portable_relative(relative)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|e| io_error("快照文件无法访问 / Cannot access snapshot file", e))?;
        if is_link(&metadata) {
            return Err(
                "快照不能包含符号链接 / Symbolic links are not allowed in snapshots.".into(),
            );
        }
    }
    let canonical = current.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("快照路径越界 / Snapshot path is outside its root.".into());
    }
    let metadata = fs::symlink_metadata(&canonical).map_err(|e| e.to_string())?;
    if (expected_directory && !metadata.is_dir()) || (!expected_directory && !metadata.is_file()) {
        return Err("快照文件类型无效 / Invalid snapshot file type.".into());
    }
    Ok(canonical)
}
fn open_regular(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000); // O_NOFOLLOW
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100); // Darwin O_NOFOLLOW
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("只允许普通文件 / Only regular files are allowed.".into());
    }
    Ok(file)
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = open_regular(path)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("文件超出备份大小限制 / File exceeds the backup size limit.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("文件在读取时变大 / File exceeded its limit while reading.".into());
    }
    Ok(bytes)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|e| e.to_string())
}
/// Atomic publication must never replace an existing destination directory.
fn rename_new(source: &Path, destination: &Path) -> Result<(), String> {
    crate::storage::rename_without_replace(source, destination).map_err(|e| e.to_string())
}
fn staged_directory<T>(
    parent: &Path,
    name: &str,
    build: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<(PathBuf, T), String> {
    let stage = parent.join(unique_name(".markwrite-pending"));
    private_directory(&stage)?;
    let final_path = parent.join(name);
    let result = build(&stage).and_then(|value| {
        rename_new(&stage, &final_path)?;
        Ok((final_path, value))
    });
    if let Err(error) = result {
        return match fs::remove_dir_all(&stage) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}\n未能清理临时目录 / Temporary files remain at {}: {cleanup}",
                stage.display()
            )),
        };
    }
    result
}
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("backup-config.json"))
}
fn read_config(path: &Path) -> Result<ConfigRecord, String> {
    if !path.exists() {
        return Ok(ConfigRecord::default());
    }
    let record: ConfigRecord = serde_json::from_slice(&read_bounded(path, MAX_CONFIG)?)
        .map_err(|e| io_error("备份配置无效 / Invalid backup configuration", e))?;
    if !(1..=168).contains(&record.config.interval_hours) || record.approved_snapshots.len() > 64 {
        return Err("备份配置超出限制 / Backup configuration exceeds its limits.".into());
    }
    Ok(record)
}
fn save_config(path: &Path, record: &ConfigRecord) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("配置目录无效 / Invalid configuration folder.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(unique_name(".backup-config"));
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("备份配置过大 / Backup configuration is too large.".into());
    }
    let result = write_new(&temp, &bytes)
        .and_then(|_| storage::replace_file(&temp, path).map_err(|e| e.to_string()));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn sanitize_settings(value: &Value, depth: usize) -> Result<Value, String> {
    if depth > 64 {
        return Err("设置嵌套过深 / Settings nesting is too deep.".into());
    }
    match value {
        Value::Object(entries) => {
            let mut clean = serde_json::Map::new();
            for (key, value) in entries {
                let compact = key
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect::<String>();
                if [
                    "apikey",
                    "secret",
                    "password",
                    "authorization",
                    "bearer",
                    "credential",
                    "accesstoken",
                    "refreshtoken",
                    "token",
                ]
                .iter()
                .any(|word| compact.contains(word))
                {
                    continue;
                }
                clean.insert(key.clone(), sanitize_settings(value, depth + 1)?);
            }
            Ok(Value::Object(clean))
        }
        Value::Array(entries) => entries
            .iter()
            .map(|value| sanitize_settings(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        value => Ok(value.clone()),
    }
}
fn included(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "md" | "markdown"
                    | "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "avif"
                    | "bmp"
                    | "svg"
            )
        })
}
struct Inventory {
    files: Vec<(String, PathBuf)>,
    skipped: usize,
    visited: usize,
}
fn inventory(root: &Path, limits: Limits) -> Result<Inventory, String> {
    fn walk(
        root: &Path,
        at: &Path,
        depth: usize,
        result: &mut Inventory,
        limits: Limits,
        names: &mut HashSet<String>,
    ) -> Result<(), String> {
        if depth > 32 {
            return Err("备份目录超过 32 层 / Backup folder is deeper than 32 levels.".into());
        }
        let entries = fs::read_dir(at).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            result.visited += 1;
            if result.visited > limits.visited {
                return Err("目录项目超过备份限制 / Too many directory entries to back up.".into());
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if is_link(&metadata) {
                result.skipped += 1;
                continue;
            }
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or("文件名不是 UTF-8 / Filename is not UTF-8.")?;
            if name.starts_with('.') || ["node_modules", "target"].contains(&name) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .components()
                .map(|part| {
                    part.as_os_str()
                        .to_str()
                        .ok_or("文件名不是 UTF-8 / Filename is not UTF-8.")
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            portable_relative(&relative)?;
            if metadata.is_dir() {
                if !path
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .starts_with(root)
                {
                    return Err(
                        "源目录发生越界变化 / Source directory moved outside its scope.".into(),
                    );
                }
                walk(root, &path, depth + 1, result, limits, names)?;
            } else if metadata.is_file() && included(&path) {
                if metadata.len() > limits.file_bytes {
                    return Err(format!("文件超过 32 MiB / File exceeds 32 MiB: {relative}"));
                }
                if !names.insert(relative.to_lowercase()) {
                    return Err("文件名大小写冲突，无法跨平台恢复 / Case-conflicting filenames cannot be restored portably.".into());
                }
                result.files.push((relative, path));
                if result.files.len() > limits.files {
                    return Err(
                        "备份超过文件数量上限 / Backup exceeds the file-count limit.".into(),
                    );
                }
            } else {
                result.skipped += 1;
            }
        }
        Ok(())
    }
    let mut result = Inventory {
        files: Vec::new(),
        skipped: 0,
        visited: 0,
    };
    walk(root, root, 0, &mut result, limits, &mut HashSet::new())?;
    result.files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(result)
}
fn file_record(relative: String, bytes: &[u8]) -> BackupFile {
    BackupFile {
        path: relative,
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}
fn summary(path: &Path, manifest: &Manifest) -> BackupSummary {
    let markdown_count = manifest
        .files
        .iter()
        .filter(|file| crate::is_markdown(Path::new(&file.path)))
        .count();
    BackupSummary {
        id: manifest.id.clone(),
        path: path.to_string_lossy().into_owned(),
        workspace_name: manifest.workspace_name.clone(),
        created_at_ms: manifest.created_at_ms,
        file_count: manifest.files.len(),
        markdown_count,
        image_count: manifest.files.len() - markdown_count,
        total_bytes: manifest.files.iter().map(|file| file.size).sum::<u64>()
            + manifest.settings.size,
        settings_included: manifest.settings_included,
        skipped_files: manifest.skipped_files,
    }
}
fn create_snapshot(
    source: &Path,
    destination: &Path,
    settings: &Value,
    limits: Limits,
) -> Result<BackupSummary, String> {
    let expected_source = source.to_path_buf();
    let source = directory(source)?;
    if source != expected_source {
        return Err(
            "源目录路径发生变化，请重新打开 / Source path changed; reopen the workspace.".into(),
        );
    }
    let destination = directory(destination)?;
    if destination.starts_with(&source) {
        return Err(
            "请选择工作文件夹以外的备份目录 / Choose a backup destination outside the workspace."
                .into(),
        );
    }
    let inventory = inventory(&source, limits)?;
    let settings = sanitize_settings(settings, 0)?;
    let settings_bytes = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
    if settings_bytes.len() as u64 > MAX_SETTINGS
        || settings_bytes.len() as u64 > limits.total_bytes
    {
        return Err("备份设置超过大小限制 / Settings exceed the backup size limit.".into());
    }
    let name = unique_name("markwrite-backup");
    let manifest = Manifest {
        version: 1,
        id: name.clone(),
        workspace_name: source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        created_at_ms: now_ms(),
        files: Vec::new(),
        settings: file_record("settings.json".into(), &settings_bytes),
        settings_included: !settings.is_null(),
        skipped_files: inventory.skipped,
    };
    let (path, manifest) = staged_directory(&destination, &name, |stage| {
        private_directory(&stage.join("files"))?;
        let mut manifest = manifest;
        let mut total = settings_bytes.len() as u64;
        for (relative, original) in inventory.files {
            let checked = checked_path(&source, &relative, false)?;
            if checked != original {
                return Err("源路径发生变化 / Source path changed during backup.".into());
            }
            let before = fs::metadata(&checked).map_err(|e| e.to_string())?;
            let bytes = read_bounded(&checked, limits.file_bytes)?;
            let after = fs::metadata(&checked).map_err(|e| e.to_string())?;
            if before.len() != after.len()
                || before.modified().ok() != after.modified().ok()
                || after.len() != bytes.len() as u64
            {
                return Err(
                    "文件在备份期间发生变化，请重试 / A file changed during backup; please retry."
                        .into(),
                );
            }
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or("备份大小溢出 / Backup size overflow.")?;
            if total > limits.total_bytes {
                return Err("备份超过 1 GiB / Backup exceeds 1 GiB.".into());
            }
            let target = stage.join("files").join(portable_relative(&relative)?);
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            write_new(&target, &bytes)?;
            manifest.files.push(file_record(relative, &bytes));
        }
        write_new(&stage.join("settings.json"), &settings_bytes)?;
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_MANIFEST {
            return Err("快照清单过大 / Snapshot manifest is too large.".into());
        }
        // The manifest is the completion marker, written and synced after every payload.
        write_new(&stage.join("manifest.json"), &bytes)?;
        Ok(manifest)
    })?;
    Ok(summary(&path, &manifest))
}
fn read_manifest(snapshot: &Path, limits: Limits) -> Result<Manifest, String> {
    let file = checked_path(snapshot, "manifest.json", false)?;
    let manifest: Manifest = serde_json::from_slice(&read_bounded(&file, MAX_MANIFEST)?)
        .map_err(|e| io_error("快照清单无效 / Invalid snapshot manifest", e))?;
    if manifest.version != 1
        || manifest.id.len() > 128
        || manifest.workspace_name.len() > 1024
        || manifest.files.len() > limits.files
    {
        return Err(
            "不支持的备份版本或文件数量超限 / Unsupported backup version or excessive file count."
                .into(),
        );
    }
    if manifest.settings.path != "settings.json" || manifest.settings.size > MAX_SETTINGS {
        return Err("备份设置记录无效 / Invalid settings entry.".into());
    }
    let mut total = manifest.settings.size;
    if total > limits.total_bytes {
        return Err(
            "备份设置超过总大小上限 / Snapshot settings exceed the total-size limit.".into(),
        );
    }
    let mut names = HashSet::new();
    for file in &manifest.files {
        portable_relative(&file.path)?;
        if !included(Path::new(&file.path))
            || file.size > limits.file_bytes
            || !names.insert(file.path.to_lowercase())
        {
            return Err("备份含重复、不支持或超限文件 / Duplicate, unsupported, or oversized snapshot file.".into());
        }
        total = total
            .checked_add(file.size)
            .ok_or("备份大小溢出 / Backup size overflow.")?;
        if total > limits.total_bytes {
            return Err("备份超过总大小上限 / Snapshot exceeds the total-size limit.".into());
        }
    }
    for file in manifest
        .files
        .iter()
        .chain(std::iter::once(&manifest.settings))
    {
        if file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("备份校验值无效 / Invalid snapshot checksum.".into());
        }
    }
    Ok(manifest)
}
fn verified_bytes(
    snapshot: &Path,
    file: &BackupFile,
    settings: bool,
    limits: Limits,
) -> Result<Vec<u8>, String> {
    let relative = if settings {
        "settings.json".into()
    } else {
        format!("files/{}", file.path)
    };
    let path = checked_path(snapshot, &relative, false)?;
    let bytes = read_bounded(
        &path,
        if settings {
            MAX_SETTINGS
        } else {
            limits.file_bytes
        },
    )?;
    if bytes.len() as u64 != file.size
        || format!("{:x}", Sha256::digest(&bytes)) != file.sha256.to_ascii_lowercase()
    {
        return Err(format!(
            "备份校验失败 / Snapshot checksum failed: {}",
            file.path
        ));
    }
    Ok(bytes)
}
fn inspect_snapshot(snapshot: &Path, limits: Limits) -> Result<BackupInspection, String> {
    let snapshot = directory(snapshot)?;
    let manifest = read_manifest(&snapshot, limits)?;
    for file in &manifest.files {
        verified_bytes(&snapshot, file, false, limits)?;
    }
    let settings_bundle = serde_json::from_slice(&verified_bytes(
        &snapshot,
        &manifest.settings,
        true,
        limits,
    )?)
    .map_err(|e| io_error("备份设置损坏 / Invalid settings JSON", e))?;
    Ok(BackupInspection {
        summary: summary(&snapshot, &manifest),
        files: manifest.files,
        settings_bundle: sanitize_settings(&settings_bundle, 0)?,
    })
}
fn restore_snapshot(
    snapshot: &Path,
    parent: &Path,
    limits: Limits,
) -> Result<BackupRestore, String> {
    let expected_snapshot = snapshot.to_path_buf();
    let snapshot = directory(snapshot)?;
    if snapshot != expected_snapshot {
        return Err(
            "快照路径发生变化，请重新选择 / Snapshot path changed; select it again.".into(),
        );
    }
    let parent = directory(parent)?;
    if parent.starts_with(&snapshot) {
        return Err("恢复位置不能在备份内部 / Restore outside the snapshot folder.".into());
    }
    let manifest = read_manifest(&snapshot, limits)?;
    let settings = verified_bytes(&snapshot, &manifest.settings, true, limits)?;
    let settings: Value = serde_json::from_slice(&settings).map_err(|e| e.to_string())?;
    let settings_bundle = sanitize_settings(&settings, 0)?;
    let name = unique_name("Markwrite-restored");
    let (path, ()) = staged_directory(&parent, &name, |stage| {
        for file in &manifest.files {
            let bytes = verified_bytes(&snapshot, file, false, limits)?;
            let destination = stage.join(portable_relative(&file.path)?);
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            write_new(&destination, &bytes)?;
        }
        Ok(())
    })?;
    Ok(BackupRestore {
        path: path.to_string_lossy().into_owned(),
        settings_bundle,
        file_count: manifest.files.len(),
        total_bytes: summary(&snapshot, &manifest).total_bytes,
    })
}
fn authorized_snapshot(record: &ConfigRecord, path: &Path) -> Result<PathBuf, String> {
    let canonical = directory(path)?;
    let selected = record
        .approved_snapshots
        .iter()
        .any(|approved| approved == &canonical);
    let in_destination = record
        .config
        .destination
        .as_ref()
        .and_then(|path| directory(Path::new(path)).ok())
        .is_some_and(|destination| {
            canonical.parent() == Some(destination.as_path())
                && canonical
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("markwrite-backup-"))
        });
    if selected || in_destination {
        Ok(canonical)
    } else {
        Err("请先选择这个备份文件夹 / Select this snapshot with the folder picker first.".into())
    }
}
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_config(app: tauri::AppHandle) -> Result<BackupConfig, String> {
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        Ok(read_config(&config_path(&app)?)?.config)
    })
    .await
}
#[tauri::command]
pub async fn backup_pick_destination(
    app: tauri::AppHandle,
) -> Result<Option<BackupConfig>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("选择备份目录 / Choose backup folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let path = directory(&path)?;
        let config_path = config_path(&app)?;
        let mut record = read_config(&config_path)?;
        let destination = path.to_string_lossy().into_owned();
        if record.config.destination.as_ref() != Some(&destination) {
            record.config.destination = Some(destination);
            record.config.last_backup_at_ms = None;
            record.config.last_error = None;
            record.config.next_backup_at_ms = next_due(&record.config, now_ms());
        }
        save_config(&config_path, &record)?;
        Ok(Some(record.config))
    })
    .await
}
#[tauri::command]
pub async fn backup_update_schedule(
    enabled: bool,
    interval_hours: u32,
    app: tauri::AppHandle,
) -> Result<BackupConfig, String> {
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        if !(1..=168).contains(&interval_hours) {
            return Err("备份间隔须为 1–168 小时 / Backup interval must be 1–168 hours.".into());
        }
        let path = config_path(&app)?;
        let mut record = read_config(&path)?;
        if enabled && record.config.destination.is_none() {
            return Err("请先选择备份目录 / Choose a backup destination first.".into());
        }
        if record.config.enabled != enabled || record.config.interval_hours != interval_hours {
            record.config.enabled = enabled;
            record.config.interval_hours = interval_hours;
            record.config.next_backup_at_ms = next_due(&record.config, now_ms());
        }
        save_config(&path, &record)?;
        Ok(record.config)
    })
    .await
}
#[tauri::command]
pub async fn backup_create(
    path: String,
    settings_bundle: Value,
    automatic: Option<bool>,
    app: tauri::AppHandle,
) -> Result<BackupSummary, String> {
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let config_path = config_path(&app)?;
        let mut record = read_config(&config_path)?;
        if automatic.unwrap_or(false) && (!record.config.enabled
            || record.config.next_backup_at_ms.is_none_or(|due| due > now_ms())) {
            return Err("BACKUP_NOT_DUE: 定期备份尚未到期或已关闭 / Scheduled backup is not due or is disabled.".into());
        }
        let result = (|| {
            let source = app.state::<AppState>().check_directory(Path::new(&path))?;
            let destination = record.config.destination.as_ref().ok_or("请先选择备份目录 / Choose a backup destination first.")?;
            create_snapshot(&source, Path::new(destination), &settings_bundle, LIMITS)
        })();
        record.config.next_backup_at_ms = next_due(&record.config, now_ms());
        match &result {
            Ok(summary) => { record.config.last_backup_at_ms = Some(summary.created_at_ms); record.config.last_error = None; }
            Err(error) => record.config.last_error = Some(error.clone()),
        }
        if let Err(error) = save_config(&config_path, &record) {
            return Err(match result { Ok(summary) => format!("备份已写入 {}，但状态无法保存 / Snapshot was saved but status could not be recorded: {error}", summary.path), Err(original) => format!("{original}\n{error}") });
        }
        result
    }).await
}
#[tauri::command]
pub async fn backup_list(app: tauri::AppHandle) -> Result<Vec<BackupSummary>, String> {
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let record = read_config(&config_path(&app)?)?;
        let Some(destination) = record.config.destination else {
            return Ok(Vec::new());
        };
        let destination = directory(Path::new(&destination))?;
        let mut candidates = Vec::new();
        for (index, entry) in fs::read_dir(&destination)
            .map_err(|e| e.to_string())?
            .enumerate()
        {
            if index >= 10_000 {
                return Err("备份目录项目过多 / Too many entries in the backup folder.".into());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if metadata.is_dir()
                && !is_link(&metadata)
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("markwrite-backup-")
            {
                candidates.push(entry.path());
            }
        }
        // Timestamped names let us bound manifest I/O as well as the directory scan.
        candidates.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        let mut summaries = Vec::new();
        for path in candidates.into_iter().take(200) {
            // Incomplete staging folders are never listed. Corrupt complete manifests
            // are reported by explicit inspection rather than breaking every backup.
            if let Ok(manifest) = read_manifest(&path, LIMITS) {
                summaries.push(summary(&path, &manifest));
            }
        }
        summaries.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        summaries.truncate(200);
        Ok(summaries)
    })
    .await
}
#[tauri::command]
pub async fn backup_pick_snapshot(
    app: tauri::AppHandle,
) -> Result<Option<BackupInspection>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_title("选择包含 manifest.json 的快照 / Choose a snapshot containing manifest.json")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let path = directory(&path)?;
        let inspection = inspect_snapshot(&path, LIMITS)?;
        let config_path = config_path(&app)?;
        let mut record = read_config(&config_path)?;
        record.approved_snapshots.retain(|old| old != &path);
        record.approved_snapshots.insert(0, path);
        record.approved_snapshots.truncate(64);
        save_config(&config_path, &record)?;
        Ok(Some(inspection))
    })
    .await
}
#[tauri::command]
pub async fn backup_inspect(
    snapshot: String,
    app: tauri::AppHandle,
) -> Result<BackupInspection, String> {
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let record = read_config(&config_path(&app)?)?;
        let path = authorized_snapshot(&record, Path::new(&snapshot))?;
        inspect_snapshot(&path, LIMITS)
    })
    .await
}
#[tauri::command]
pub async fn backup_restore(
    snapshot: String,
    app: tauri::AppHandle,
) -> Result<Option<BackupRestore>, String> {
    // Validate authorization before asking for a destination; revalidate after the picker.
    {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        authorized_snapshot(&read_config(&config_path(&app)?)?, Path::new(&snapshot))?;
    }
    let Some(parent) = app.dialog().file().set_title("选择恢复位置（新建独立文件夹） / Choose restore location (a new folder will be created)").blocking_pick_folder() else { return Ok(None); };
    let parent = parent.into_path().map_err(|e| e.to_string())?;
    blocking(move || {
        let _lock = OPERATIONS.lock().map_err(|e| e.to_string())?;
        let record = read_config(&config_path(&app)?)?;
        let snapshot = authorized_snapshot(&record, Path::new(&snapshot))?;
        let restored = restore_snapshot(&snapshot, &parent, LIMITS)?;
        let root = PathBuf::from(&restored.path);
        let state = app.state::<AppState>();
        let added = state.access.lock().map_err(|e| e.to_string())?.roots.insert(root.clone());
        if let Err(error) = state.persist(&app) {
            if added { state.access.lock().map_err(|e| e.to_string())?.roots.remove(&root); }
            return Err(format!("恢复文件已写入 {}，但授权无法保存 / Files were restored but app access could not be saved: {error}", restored.path));
        }
        Ok(Some(restored))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(unique_name("markwrite-backup-test"));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn write_fixture(root: &Path) {
        fs::create_dir_all(root.join("子目录/assets")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join("中文 note.md"),
            "# 你好\r\n\r\n![图](子目录/assets/pic.png)\r\n",
        )
        .unwrap();
        fs::write(root.join("子目录/next.markdown"), "另一个文档").unwrap();
        fs::write(
            root.join("子目录/assets/pic.png"),
            b"binary image bytes\0\xff",
        )
        .unwrap();
        fs::write(root.join("unrelated.txt"), "not a Markdown attachment").unwrap();
        fs::write(root.join(".git/config"), "private repository setting").unwrap();
    }
    fn rewrite_manifest(snapshot: &Path, transform: impl FnOnce(&mut Manifest)) {
        let path = snapshot.join("manifest.json");
        let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        transform(&mut manifest);
        fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }
    #[test]
    fn snapshot_roundtrip_preserves_markdown_images_and_settings_without_overwriting() {
        let fixture = Fixture::new();
        let source = fixture.dir("workspace");
        let backups = fixture.dir("backups");
        let restore = fixture.dir("restore");
        write_fixture(&source);
        fs::write(restore.join("中文 note.md"), "existing document").unwrap();
        let settings = serde_json::json!({"settings":{"language":"en","apiKey":"do-not-copy","nested":{"password":"hidden","fontSize":19}},"customThemes":[{"name":"My theme","css":"#write {color:#333}"}]});
        let saved = create_snapshot(&source, &backups, &settings, LIMITS).unwrap();
        assert_eq!(saved.file_count, 3);
        assert_eq!(saved.markdown_count, 2);
        assert_eq!(saved.image_count, 1);
        let snapshot = Path::new(&saved.path);
        let inspected = inspect_snapshot(snapshot, LIMITS).unwrap();
        assert_eq!(inspected.settings_bundle["settings"]["language"], "en");
        assert!(inspected.settings_bundle["settings"]
            .get("apiKey")
            .is_none());
        assert!(inspected.settings_bundle["settings"]["nested"]
            .get("password")
            .is_none());
        assert_eq!(
            inspected.settings_bundle["customThemes"][0]["name"],
            "My theme"
        );
        assert!(!fs::read_to_string(snapshot.join("settings.json"))
            .unwrap()
            .contains("do-not-copy"));
        let restored = restore_snapshot(snapshot, &restore, LIMITS).unwrap();
        let restored_path = Path::new(&restored.path);
        assert_eq!(restored_path.parent(), Some(restore.as_path()));
        assert_ne!(restored_path, restore);
        assert_eq!(
            fs::read(restore.join("中文 note.md")).unwrap(),
            b"existing document"
        );
        for file in &inspected.files {
            assert_eq!(
                fs::read(source.join(&file.path)).unwrap(),
                fs::read(restored_path.join(&file.path)).unwrap()
            );
        }
        assert!(!restored_path.join("unrelated.txt").exists());
        assert!(!restored_path.join(".git").exists());
        assert_eq!(restored.settings_bundle, inspected.settings_bundle);
        let again = restore_snapshot(snapshot, &restore, LIMITS).unwrap();
        assert_ne!(restored.path, again.path);
    }
    #[test]
    fn snapshot_scope_requires_a_selected_workspace_or_snapshot() {
        let fixture = Fixture::new();
        let source = fixture.dir("unselected");
        fs::write(source.join("secret.md"), "secret").unwrap();
        let state = AppState::default();
        assert!(state.check_directory(&source).is_err());
        state.allow_file(&source.join("secret.md")).unwrap();
        assert!(state.check_directory(&source).is_err());
        let record = ConfigRecord::default();
        assert!(authorized_snapshot(&record, &source).is_err());
        let selected = ConfigRecord {
            approved_snapshots: vec![source.canonicalize().unwrap()],
            ..Default::default()
        };
        assert_eq!(
            authorized_snapshot(&selected, &source).unwrap(),
            source.canonicalize().unwrap()
        );
        assert!(authorized_snapshot(&selected, &fixture.0).is_err());
    }
    #[test]
    fn tampered_payloads_and_settings_fail_checksums_before_restore_publication() {
        let fixture = Fixture::new();
        let source = fixture.dir("workspace");
        let backups = fixture.dir("backups");
        let restore = fixture.dir("restore");
        fs::write(source.join("note.md"), "original").unwrap();
        let saved = create_snapshot(
            &source,
            &backups,
            &serde_json::json!({"language":"en"}),
            LIMITS,
        )
        .unwrap();
        let snapshot = Path::new(&saved.path);
        fs::write(snapshot.join("files/note.md"), "tampered").unwrap();
        assert!(inspect_snapshot(snapshot, LIMITS)
            .unwrap_err()
            .contains("checksum"));
        assert!(restore_snapshot(snapshot, &restore, LIMITS).is_err());
        assert_eq!(fs::read_dir(&restore).unwrap().count(), 0);
        fs::write(snapshot.join("files/note.md"), "original").unwrap();
        fs::write(snapshot.join("settings.json"), "{\"language\":\"zh-CN\"}").unwrap();
        assert!(inspect_snapshot(snapshot, LIMITS).is_err());
    }
    #[test]
    fn manifests_reject_traversal_absolute_paths_duplicate_names_and_unknown_versions() {
        let fixture = Fixture::new();
        let source = fixture.dir("workspace");
        let backups = fixture.dir("backups");
        fs::write(source.join("note.md"), "ok").unwrap();
        for invalid in [
            "../outside.md",
            "/outside.md",
            "C:/outside.md",
            "folder\\outside.md",
            "folder/./note.md",
            "folder//note.md",
            "CON.md",
        ] {
            let saved = create_snapshot(&source, &backups, &Value::Null, LIMITS).unwrap();
            let snapshot = Path::new(&saved.path);
            rewrite_manifest(snapshot, |manifest| manifest.files[0].path = invalid.into());
            assert!(read_manifest(snapshot, LIMITS).is_err(), "{invalid}");
        }
        let saved = create_snapshot(&source, &backups, &Value::Null, LIMITS).unwrap();
        let snapshot = Path::new(&saved.path);
        rewrite_manifest(snapshot, |manifest| {
            let mut duplicate = manifest.files[0].clone();
            duplicate.path = "NOTE.md".into();
            manifest.files.push(duplicate);
        });
        assert!(read_manifest(snapshot, LIMITS).is_err());
        let saved = create_snapshot(&source, &backups, &Value::Null, LIMITS).unwrap();
        let snapshot = Path::new(&saved.path);
        rewrite_manifest(snapshot, |manifest| manifest.version = 999);
        assert!(read_manifest(snapshot, LIMITS).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_in_sources_and_refused_in_snapshot_payloads() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let source = fixture.dir("workspace");
        let outside = fixture.dir("outside");
        let backups = fixture.dir("backups");
        fs::write(source.join("note.md"), "safe").unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(outside.join("secret.md"), source.join("link.md")).unwrap();
        symlink(&outside, source.join("linked-folder")).unwrap();
        let saved = create_snapshot(&source, &backups, &Value::Null, LIMITS).unwrap();
        assert_eq!(saved.file_count, 1);
        let snapshot = Path::new(&saved.path);
        fs::remove_file(snapshot.join("files/note.md")).unwrap();
        symlink(outside.join("secret.md"), snapshot.join("files/note.md")).unwrap();
        assert!(inspect_snapshot(snapshot, LIMITS).is_err());
        fs::remove_file(snapshot.join("files/note.md")).unwrap();
        fs::remove_dir(snapshot.join("files")).unwrap();
        symlink(&outside, snapshot.join("files")).unwrap();
        assert!(inspect_snapshot(snapshot, LIMITS).is_err());
    }
    #[test]
    fn size_count_limits_and_nested_destinations_fail_without_partial_snapshots() {
        let fixture = Fixture::new();
        let source = fixture.dir("workspace");
        let backups = fixture.dir("backups");
        fs::write(source.join("first.md"), "12345678").unwrap();
        fs::write(source.join("second.md"), "12345678").unwrap();
        let tiny_total = Limits {
            total_bytes: 12,
            ..LIMITS
        };
        assert!(create_snapshot(&source, &backups, &Value::Null, tiny_total).is_err());
        assert_eq!(fs::read_dir(&backups).unwrap().count(), 0);
        assert!(create_snapshot(
            &source,
            &backups,
            &Value::Null,
            Limits { files: 1, ..LIMITS }
        )
        .is_err());
        assert!(create_snapshot(
            &source,
            &backups,
            &Value::Null,
            Limits {
                file_bytes: 2,
                ..LIMITS
            }
        )
        .is_err());
        let nested = source.join("backup");
        fs::create_dir(&nested).unwrap();
        assert!(create_snapshot(&source, &nested, &Value::Null, LIMITS).is_err());
        assert_eq!(fs::read_dir(&nested).unwrap().count(), 0);
    }
    #[test]
    fn staged_writes_clean_failure_and_atomic_publish_never_replaces_existing_folders() {
        let fixture = Fixture::new();
        let parent = fixture.dir("destination");
        let result = staged_directory::<()>(&parent, "result", |stage| {
            write_new(&stage.join("partial.md"), b"partial")?;
            Err("injected write failure".into())
        });
        assert!(result.unwrap_err().contains("injected"));
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        fs::create_dir(parent.join("result")).unwrap();
        fs::write(parent.join("result/original.md"), "preserve").unwrap();
        assert!(staged_directory(&parent, "result", |stage| write_new(
            &stage.join("new.md"),
            b"new"
        ))
        .is_err());
        assert_eq!(
            fs::read_to_string(parent.join("result/original.md")).unwrap(),
            "preserve"
        );
        assert!(!parent.join("result/new.md").exists());
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
        fs::create_dir(parent.join("empty")).unwrap();
        assert!(staged_directory(&parent, "empty", |_| Ok(())).is_err());
        assert!(parent.join("empty").is_dir());
    }
    #[test]
    fn backup_configuration_roundtrips_schedule_and_never_contains_settings_secrets() {
        let fixture = Fixture::new();
        let path = fixture.0.join("backup-config.json");
        assert!(read_config(&path).unwrap().config.destination.is_none());
        let mut record = ConfigRecord::default();
        record.config.destination = Some(fixture.dir("backups").to_string_lossy().into_owned());
        record.config.enabled = true;
        record.config.interval_hours = 4;
        record.config.next_backup_at_ms = next_due(&record.config, 1000);
        save_config(&path, &record).unwrap();
        let saved = read_config(&path).unwrap();
        assert_eq!(saved.config.next_backup_at_ms, Some(14_401_000));
        assert!(saved.config.last_backup_at_ms.is_none());
        record.config.enabled = false;
        assert_eq!(next_due(&record.config, 1000), None);
        assert!(!fs::read_to_string(path).unwrap().contains("apiKey"));
    }
}
