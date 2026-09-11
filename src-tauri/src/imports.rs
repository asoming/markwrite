//! Import source bytes are read only after the native picker and are never modified here.
//! HTML sources retain an authorized context for resolving local image attachments.
use crate::AppState;
use serde::Serialize;
use std::{fs, io::Read, path::Path};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
const FILE_LIMIT: usize = 32 * 1024 * 1024;
const BATCH_LIMIT: usize = 64 * 1024 * 1024;
#[derive(Serialize)]
pub struct ImportSource {
    path: String,
    name: String,
    extension: String,
    bytes: Vec<u8>,
}
fn u16_at(bytes: &[u8], offset: usize) -> Result<usize, String> {
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..offset + 2)
            .ok_or("DOCX 文件结构不完整。")?
            .try_into()
            .unwrap(),
    ) as usize)
}
fn u32_at(bytes: &[u8], offset: usize) -> Result<usize, String> {
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..offset + 4)
            .ok_or("DOCX 文件结构不完整。")?
            .try_into()
            .unwrap(),
    ) as usize)
}
fn validate_docx(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"PK\x03\x04") || bytes.len() < 22 {
        return Err("这不是有效的 DOCX 文件，请用 Word 另存为 .docx 后重试。".into());
    }
    let end = (bytes.len().saturating_sub(65557)..=bytes.len() - 22)
        .rev()
        .find(|&i| {
            bytes.get(i..i + 4) == Some(b"PK\x05\x06")
                && u16_at(bytes, i + 20).is_ok_and(|size| i + 22 + size == bytes.len())
        })
        .ok_or("DOCX 文件尾部不完整，可能已损坏或尚未下载完成。")?;
    let entries = u16_at(bytes, end + 10)?;
    if u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
        || entries != u16_at(bytes, end + 8)?
        || entries == 65535
        || entries > 10000
    {
        return Err("不支持分卷、ZIP64 或包含超过 10,000 项的 DOCX 文件。".into());
    }
    let size = u32_at(bytes, end + 12)?;
    let offset = u32_at(bytes, end + 16)?;
    let limit = offset
        .checked_add(size)
        .filter(|limit| *limit <= end)
        .ok_or("DOCX 目录结构无效。")?;
    let mut cursor = offset;
    let mut total = 0usize;
    let mut document = false;
    let mut types = false;
    for _ in 0..entries {
        if bytes.get(cursor..cursor + 4) != Some(b"PK\x01\x02") {
            return Err("DOCX 目录内容已损坏。".into());
        }
        if u16_at(bytes, cursor + 8)? & 1 != 0 {
            return Err("无法导入加密的 DOCX，请先解除密码保护。".into());
        }
        if ![0, 8].contains(&u16_at(bytes, cursor + 10)?) {
            return Err("DOCX 使用了不支持的压缩格式，请用 Word 重新另存。".into());
        }
        let expanded = u32_at(bytes, cursor + 24)?;
        total = total
            .checked_add(expanded)
            .filter(|size| *size <= 128 * 1024 * 1024)
            .ok_or("DOCX 解压内容超过 128MB，请精简后重试。")?;
        let name_len = u16_at(bytes, cursor + 28)?;
        let next = cursor
            .checked_add(46 + name_len + u16_at(bytes, cursor + 30)? + u16_at(bytes, cursor + 32)?)
            .filter(|next| *next <= limit)
            .ok_or("DOCX 目录边界无效。")?;
        let name = bytes
            .get(cursor + 46..cursor + 46 + name_len)
            .ok_or("DOCX 文件名无效。")?;
        document |= name == b"word/document.xml";
        types |= name == b"[Content_Types].xml";
        cursor = next;
    }
    if cursor != limit || !document || !types {
        return Err("文件中没有完整的 Word 文档结构；普通 ZIP 文件不能作为 DOCX 导入。".into());
    }
    Ok(())
}
fn read_source(path: &Path) -> Result<ImportSource, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("无法访问导入文件：{e}"))?;
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["txt", "html", "htm", "docx"].contains(&extension.as_str()) {
        return Err("只支持 TXT、HTML 和 DOCX 文件。".into());
    }
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > FILE_LIMIT as u64 {
        return Err("导入来源必须是小于等于 32MB 的普通文件。".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(FILE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > FILE_LIMIT {
        return Err("导入文件超过 32MB。".into());
    }
    if extension == "docx" {
        validate_docx(&bytes)?;
    }
    Ok(ImportSource {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        extension,
        bytes,
    })
}
#[tauri::command]
pub async fn choose_import_files(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<ImportSource>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("可导入的文档", &["txt", "html", "htm", "docx"])
        .blocking_pick_files()
        .unwrap_or_default();
    if selected.len() > 16 {
        return Err("一次最多导入 16 个文件，请分批选择。".into());
    }
    let mut sources = Vec::new();
    let mut total = 0;
    for path in selected {
        let path = path.into_path().map_err(|e| e.to_string())?;
        let source = read_source(&path).map_err(|e| {
            format!(
                "{}：{e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
        total += source.bytes.len();
        if total > BATCH_LIMIT {
            return Err("本次导入合计超过 64MB，请分批选择。".into());
        }
        if ["html", "htm"].contains(&source.extension.as_str()) {
            state.allow_file(Path::new(&source.path))?;
        }
        sources.push(source);
    }
    state.persist(&app)?;
    Ok(sources)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn minimal_docx() -> Vec<u8> {
        let mut bytes = b"PK\x03\x04".to_vec();
        let mut directory = Vec::new();
        for name in ["[Content_Types].xml", "word/document.xml"] {
            let mut header = vec![0; 46];
            header[..4].copy_from_slice(b"PK\x01\x02");
            header[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend(header);
            directory.extend(name.as_bytes());
        }
        bytes.extend(&directory);
        let mut end = vec![0; 22];
        end[..4].copy_from_slice(b"PK\x05\x06");
        end[8..10].copy_from_slice(&2u16.to_le_bytes());
        end[10..12].copy_from_slice(&2u16.to_le_bytes());
        end[12..16].copy_from_slice(&(directory.len() as u32).to_le_bytes());
        end[16..20].copy_from_slice(&4u32.to_le_bytes());
        bytes.extend(end);
        bytes
    }
    #[test]
    fn docx_checks_structure_and_expansion_budget() {
        let valid = minimal_docx();
        assert!(validate_docx(&valid).is_ok());
        let mut huge = valid.clone();
        huge[28..32].copy_from_slice(&(129u32 * 1024 * 1024).to_le_bytes());
        assert!(validate_docx(&huge).is_err());
        let mut encrypted = valid.clone();
        encrypted[12] = 1;
        assert!(validate_docx(&encrypted).is_err());
        assert!(validate_docx(b"ordinary text renamed to docx").is_err());
        assert!(validate_docx(&valid[..valid.len() - 2]).is_err());
    }
    #[test]
    fn imports_preserve_source_bytes_and_reject_unselected_types() {
        let path = std::env::temp_dir().join(format!(
            "markwrite-import-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let original = b"\xff\xfeA\x00\r\x00\n\x00";
        fs::write(&path, original).unwrap();
        let source = read_source(&path).unwrap();
        assert_eq!(source.bytes, original);
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_file(path).unwrap();
        assert!(read_source(Path::new("Cargo.toml")).is_err());
    }
}
