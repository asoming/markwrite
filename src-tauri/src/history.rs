//! Local pre-write history, capped at 50 versions per document and 200 MiB total.
//! Versions are recovery conveniences; this is not a substitute for a backup.
use crate::storage::{self, DiskFile};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
const PER_DOCUMENT: usize = 50;
const TOTAL_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub created_at: u64,
    pub size: u64,
}
fn directory(root: &Path, document: &Path) -> PathBuf {
    root.join(storage::version(document.to_string_lossy().as_bytes()))
}
fn versions(dir: &Path) -> Result<Vec<(Version, PathBuf)>, String> {
    let mut entries = Vec::new();
    if !dir.exists() {
        return Ok(entries);
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let Some(stamp) = id
            .strip_suffix(".md")
            .and_then(|s| s.split('-').next())
            .and_then(|s| s.parse::<u128>().ok())
        else {
            continue;
        };
        entries.push((
            Version {
                id,
                created_at: (stamp / 1_000_000) as u64,
                size: entry.metadata().map_err(|e| e.to_string())?.len(),
            },
            entry.path(),
        ));
    }
    entries.sort_by(|a, b| b.0.id.cmp(&a.0.id));
    Ok(entries)
}
pub fn list(root: &Path, document: &Path) -> Result<Vec<Version>, String> {
    Ok(versions(&directory(root, document))?
        .into_iter()
        .map(|v| v.0)
        .collect())
}
#[cfg(test)]
pub fn read(root: &Path, document: &Path, id: &str) -> Result<DiskFile, String> {
    read_with_encoding(root, document, id, None)
}
pub fn read_with_encoding(
    root: &Path,
    document: &Path,
    id: &str,
    encoding: Option<crate::text_encoding::TextEncoding>,
) -> Result<DiskFile, String> {
    // Never use caller text as an unchecked path component.
    let entry = versions(&directory(root, document))?
        .into_iter()
        .find(|v| v.0.id == id)
        .ok_or("历史版本不存在或已按保留规则清理。")?;
    let mut file = match encoding {
        Some(encoding) => crate::text_encoding::read(&entry.1, encoding)?,
        None => storage::read(&entry.1)?,
    };
    file.path = document.to_string_lossy().into_owned();
    Ok(file)
}
pub fn relocate(root: &Path, old: &Path, new: &Path) -> Result<(), String> {
    let from = directory(root, old);
    if !from.exists() {
        return Ok(());
    }
    let to = directory(root, new);
    fs::create_dir_all(&to).map_err(|e| e.to_string())?;
    for (_, path) in versions(&from)? {
        let dest = to.join(path.file_name().ok_or("历史路径无效。")?);
        if !dest.exists() {
            fs::rename(path, dest).map_err(|e| e.to_string())?;
        }
    }
    let _ = fs::remove_dir(from);
    Ok(())
}
pub fn snapshot(root: &Path, document: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = directory(root, document);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建历史目录：{e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = dir.join(format!("{stamp:020}-{}.md", &storage::version(bytes)[..16]));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
        .map_err(|e| format!("无法创建恢复副本：{e}"))?;
    if let Err(e) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(target);
        return Err(format!("无法保存恢复副本：{e}"));
    }
    drop(file);
    for old in versions(&dir)?.into_iter().skip(PER_DOCUMENT) {
        fs::remove_file(old.1).map_err(|e| e.to_string())?;
    }
    let mut all = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            all.extend(versions(&entry.path())?);
        }
    }
    all.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    let mut total: u64 = all.iter().map(|v| v.0.size).sum();
    for old in all {
        if total <= TOTAL_BYTES {
            break;
        }
        fs::remove_file(old.1).map_err(|e| e.to_string())?;
        total = total.saturating_sub(old.0.size);
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_versions_and_rejects_traversal() {
        let dir = std::env::temp_dir().join(format!(
            "markwrite-history-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let document = dir.join("中文.md");
        snapshot(&dir.join("history"), &document, b"one").unwrap();
        snapshot(&dir.join("history"), &document, b"two").unwrap();
        let items = list(&dir.join("history"), &document).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            read(&dir.join("history"), &document, &items[0].id)
                .unwrap()
                .content,
            "two"
        );
        assert!(read(&dir.join("history"), &document, "../../secret").is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn caps_versions_per_document() {
        let dir = std::env::temp_dir().join(format!(
            "markwrite-history-cap-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for i in 0..55 {
            snapshot(&dir, Path::new("note.md"), i.to_string().as_bytes()).unwrap();
        }
        assert_eq!(list(&dir, Path::new("note.md")).unwrap().len(), 50);
        fs::remove_dir_all(dir).unwrap();
    }
}
