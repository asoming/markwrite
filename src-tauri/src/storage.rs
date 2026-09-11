use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct DiskFile {
    pub path: String,
    pub content: String,
    pub version: String,
    pub bom: bool,
    pub crlf: bool,
}
pub fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn read(path: &Path) -> Result<DiskFile, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件：{e}"))?;
    if metadata.len() > 32 * 1024 * 1024 {
        return Err("文件超过当前版本的 32MB 限制。".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let raw = String::from_utf8(bytes.clone())
        .map_err(|_| "文件不是有效的 UTF-8。请先转换编码，原文件未更改。")?;
    Ok(DiskFile {
        path: path.to_string_lossy().into_owned(),
        content: raw
            .strip_prefix('\u{feff}')
            .unwrap_or(&raw)
            .replace("\r\n", "\n"),
        version: version(&bytes),
        bom: bytes.starts_with(&[239, 187, 191]),
        crlf: raw.contains("\r\n"),
    })
}
pub fn serialize(file: &DiskFile) -> Vec<u8> {
    let mut text = if file.bom {
        "\u{feff}".to_owned()
    } else {
        String::new()
    };
    text.push_str(&if file.crlf {
        file.content.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        file.content.clone()
    });
    text.into_bytes()
}
pub fn atomic_write(
    path: &Path,
    bytes: &[u8],
    expected: Option<&str>,
    backup_dir: &Path,
) -> Result<(), String> {
    let parent = path.parent().ok_or("没有有效的父目录")?;
    let existing = match fs::read(path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    match (expected, existing.as_deref()) {
        (Some(v), Some(b)) if version(b) != v => {
            return Err("CONFLICT:磁盘上的文件已经变化。当前编辑内容已保留。".into())
        }
        (Some(_), None) => return Err("CONFLICT:文件已被移动或删除。请另存为。".into()),
        _ => {}
    }
    if existing.as_deref() == Some(bytes) {
        return Ok(());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(".markwrite-{}-{nonce}.tmp", std::process::id()));
    let result = (|| {
        let mut out = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        if let Ok(meta) = fs::metadata(path) {
            fs::set_permissions(&temp, meta.permissions()).map_err(|e| e.to_string())?;
        }
        out.write_all(bytes).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        // Recheck immediately before replacement; keep one pre-write snapshot per canonical path.
        let current = match fs::read(path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != existing {
            return Err("CONFLICT:写入前文件再次发生变化，请比较磁盘版本。".into());
        }
        if let Some(old) = existing.as_deref() {
            fs::create_dir_all(backup_dir).map_err(|e| format!("无法创建恢复副本：{e}"))?;
            fs::write(
                backup_dir.join(format!("{}.md", version(path.to_string_lossy().as_bytes()))),
                old,
            )
            .map_err(|e| format!("无法保存恢复副本：{e}"))?;
        }
        fs::rename(&temp, path).map_err(|e| e.to_string())?;
        if let Ok(dir) = fs::File::open(parent) {
            dir.sync_all().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    fn sandbox(label: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "markwrite-test-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn preserves_bom_crlf() {
        let p = sandbox("encoding");
        let f = p.join("文档.md");
        let raw = "\u{feff}# 标题\r\n原文  \r\n".as_bytes();
        fs::write(&f, raw).unwrap();
        let d = read(&f).unwrap();
        assert_eq!(serialize(&d), raw);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn preserves_a_second_leading_unicode_character() {
        let p = sandbox("double-bom");
        let f = p.join("note.md");
        let raw = "\u{feff}\u{feff}正文".as_bytes();
        fs::write(&f, raw).unwrap();
        assert_eq!(serialize(&read(&f).unwrap()), raw);
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn failed_backup_does_not_replace_original() {
        let p = sandbox("backup-failure");
        let f = p.join("note.md");
        let blocked = p.join("not-a-directory");
        fs::write(&f, "original").unwrap();
        fs::write(&blocked, "block").unwrap();
        let d = read(&f).unwrap();
        assert!(atomic_write(&f, b"changed", Some(&d.version), &blocked).is_err());
        assert_eq!(fs::read_to_string(&f).unwrap(), "original");
        assert!(!fs::read_dir(&p).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn conflict_never_overwrites() {
        let p = sandbox("conflict");
        let f = p.join("note.md");
        fs::write(&f, "first").unwrap();
        let d = read(&f).unwrap();
        fs::write(&f, "external").unwrap();
        assert!(
            atomic_write(&f, b"ours", Some(&d.version), &p.join("backup"))
                .unwrap_err()
                .starts_with("CONFLICT:")
        );
        assert_eq!(fs::read_to_string(&f).unwrap(), "external");
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn write_keeps_previous_copy() {
        let p = sandbox("backup");
        let f = p.join("note.md");
        fs::write(&f, "first").unwrap();
        let d = read(&f).unwrap();
        atomic_write(&f, b"second", Some(&d.version), &p.join("backup")).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "second");
        assert_eq!(
            fs::read_to_string(
                fs::read_dir(p.join("backup"))
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path()
            )
            .unwrap(),
            "first"
        );
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn deleted_file_conflicts() {
        let p = sandbox("deleted");
        let f = p.join("note.md");
        assert!(atomic_write(&f, b"ours", Some("old"), &p.join("backup")).is_err());
        assert!(!f.exists());
        fs::remove_dir_all(p).unwrap();
    }
    #[test]
    fn invalid_utf8_is_rejected() {
        let p = sandbox("utf8");
        let f = p.join("note.md");
        fs::write(&f, [255, 254, 0]).unwrap();
        assert!(read(&f).is_err());
        fs::remove_dir_all(p).unwrap();
    }
}
