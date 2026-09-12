use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};
static LOCK_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
pub fn configure_lock_directory(path: PathBuf) {
    let _ = LOCK_DIRECTORY.set(path);
}
fn document_lock(path: &Path) -> Result<fs::File, String> {
    let directory = match LOCK_DIRECTORY.get() {
        Some(path) => path.clone(),
        None => {
            #[cfg(test)]
            {
                std::env::temp_dir()
                    .join(format!("markwrite-unit-file-locks-{}", std::process::id()))
            }
            #[cfg(not(test))]
            {
                return Err("保存锁尚未初始化 / Document save lock is not initialized.".into());
            }
        }
    };
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let absolute = path
        .canonicalize()
        .or_else(|_| {
            path.parent()
                .ok_or_else(|| std::io::Error::other("Missing parent"))?
                .canonicalize()
                .map(|parent| parent.join(path.file_name().unwrap_or_default()))
        })
        .map_err(|e| e.to_string())?;
    let key = absolute.to_string_lossy().into_owned();
    #[cfg(windows)]
    let key = key.to_lowercase();
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(directory.join(version(key.as_bytes())))
        .map_err(|e| e.to_string())?;
    // The lock lives in shared application data, never alongside user documents.
    // It is released by the OS even when one document process is terminated.
    fs2::FileExt::lock_exclusive(&lock).map_err(|e| e.to_string())?;
    Ok(lock)
}

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
    let _process_guard = document_lock(path)?;
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
        // Recheck immediately before replacement; snapshot the displaced content.
        let current = match fs::read(path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if current != existing {
            return Err("CONFLICT:写入前文件再次发生变化，请比较磁盘版本。".into());
        }
        if let Some(old) = existing.as_deref() {
            crate::history::snapshot(backup_dir, path, old)?;
        }
        drop(out);
        replace_file(&temp, path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
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

/// Rename a file or directory without ever replacing a concurrently created destination.
#[cfg(target_os = "linux")]
pub fn rename_without_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renameat2(
            old_dir: i32,
            old_path: *const std::ffi::c_char,
            new_dir: i32,
            new_path: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid source path")
    })?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid target path")
    })?;
    // Linux AT_FDCWD=-100 and RENAME_NOREPLACE=1; pointers live throughout the call.
    let result = unsafe { renameat2(-100, source.as_ptr(), -100, target.as_ptr(), 1) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(windows)]
pub fn rename_without_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(any(target_os = "linux", windows)))]
pub fn rename_without_replace(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Safe rename is currently supported on Linux and Windows.",
    ))
}

/// Same-volume replacement preserves the existing target until the replacement succeeds.
#[cfg(not(windows))]
pub fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}
#[cfg(windows)]
pub fn replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both NUL-terminated buffers remain alive for this synchronous Win32 call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "helper invoked by cross_process_saves_recheck_the_original_version"]
    fn cross_process_save_child() {
        let root = PathBuf::from(std::env::var("MARKWRITE_SAVE_TEST_ROOT").unwrap());
        let name = std::env::var("MARKWRITE_SAVE_TEST_CHILD").unwrap();
        configure_lock_directory(root.join("locks"));
        let expected = version(b"original");
        fs::write(root.join(format!("{name}.ready")), b"ready").unwrap();
        let began = std::time::Instant::now();
        while !root.join("start").exists() {
            assert!(
                began.elapsed().as_secs() < 10,
                "parent did not release children"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let result = atomic_write(
            &root.join("document.md"),
            name.as_bytes(),
            Some(&expected),
            &root.join(format!("{name}-history")),
        );
        let outcome = match result {
            Ok(()) => "saved",
            Err(error) if error.starts_with("CONFLICT:") => "conflict",
            Err(error) => panic!("{error}"),
        };
        fs::write(root.join(format!("{name}.result")), outcome).unwrap();
    }
    #[test]
    fn cross_process_saves_recheck_the_original_version() {
        let root = sandbox("cross-process");
        fs::write(root.join("document.md"), b"original").unwrap();
        let mut children = Vec::new();
        for name in ["first", "second"] {
            children.push(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "storage::tests::cross_process_save_child",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("MARKWRITE_SAVE_TEST_ROOT", &root)
                    .env("MARKWRITE_SAVE_TEST_CHILD", name)
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }
        let began = std::time::Instant::now();
        while !root.join("first.ready").exists() || !root.join("second.ready").exists() {
            if began.elapsed().as_secs() >= 15 {
                for child in &mut children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                panic!("save processes did not start");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        fs::write(root.join("start"), b"start").unwrap();
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let mut outcomes = [
            fs::read_to_string(root.join("first.result")).unwrap(),
            fs::read_to_string(root.join("second.result")).unwrap(),
        ];
        outcomes.sort();
        assert_eq!(outcomes, ["conflict", "saved"]);
        assert!([b"first".as_slice(), b"second".as_slice()]
            .contains(&fs::read(root.join("document.md")).unwrap().as_slice()));
        fs::remove_dir_all(root).unwrap();
    }
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
        let entries = crate::history::list(&p.join("backup"), &f).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            crate::history::read(&p.join("backup"), &f, &entries[0].id)
                .unwrap()
                .content,
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
    fn restore_creates_history_of_the_replaced_version() {
        let root = sandbox("history-restore");
        let document = root.join("note.md");
        let backup = root.join("history");
        fs::write(&document, "one").unwrap();
        atomic_write(
            &document,
            b"two",
            Some(&read(&document).unwrap().version),
            &backup,
        )
        .unwrap();
        let old = crate::history::list(&backup, &document).unwrap();
        let restored = crate::history::read(&backup, &document, &old[0].id).unwrap();
        atomic_write(
            &document,
            &serialize(&restored),
            Some(&read(&document).unwrap().version),
            &backup,
        )
        .unwrap();
        assert_eq!(read(&document).unwrap().content, "one");
        let versions = crate::history::list(&backup, &document).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            crate::history::read(&backup, &document, &versions[0].id)
                .unwrap()
                .content,
            "two"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rename_cannot_overwrite_an_existing_destination() {
        let root = sandbox("rename-no-replace");
        let a = root.join("a.md");
        let b = root.join("b.md");
        fs::write(&a, "source").unwrap();
        fs::write(&b, "destination").unwrap();
        assert!(rename_without_replace(&a, &b).is_err());
        assert_eq!(fs::read_to_string(&a).unwrap(), "source");
        assert_eq!(fs::read_to_string(&b).unwrap(), "destination");
        #[cfg(unix)]
        {
            let link = root.join("dangling.md");
            std::os::unix::fs::symlink(root.join("missing"), &link).unwrap();
            assert!(rename_without_replace(&a, &link).is_err());
        }
        fs::remove_dir_all(root).unwrap();
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
