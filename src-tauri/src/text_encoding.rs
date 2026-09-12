//! Explicit decoding never writes the source. Encoding errors are fatal, never replaced.
use crate::{storage, AppState};
use encoding_rs::{GB18030, GBK, UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub enum TextEncoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "gb18030")]
    Gb18030,
    #[serde(rename = "gbk")]
    Gbk,
}
#[derive(Serialize)]
pub struct EncodedDocument {
    #[serde(flatten)]
    pub file: storage::DiskFile,
    pub encoding: TextEncoding,
}
fn marker(encoding: TextEncoding) -> &'static [u8] {
    match encoding {
        TextEncoding::Utf8 => &[0xef, 0xbb, 0xbf],
        TextEncoding::Utf16Le => &[0xff, 0xfe],
        TextEncoding::Utf16Be => &[0xfe, 0xff],
        _ => &[],
    }
}
pub fn decode(bytes: &[u8], encoding: TextEncoding) -> Result<(String, bool), String> {
    let detected = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(TextEncoding::Utf8)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        Some(TextEncoding::Utf16Le)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some(TextEncoding::Utf16Be)
    } else {
        None
    };
    if detected.is_some_and(|value| value != encoding) {
        return Err(
            "所选编码与文件 BOM 不一致，请换一种编码预览 / Encoding does not match the file BOM."
                .into(),
        );
    }
    let bom = detected.is_some();
    let payload = if bom {
        &bytes[marker(encoding).len()..]
    } else {
        bytes
    };
    let text = match encoding {
        TextEncoding::Utf8 => std::str::from_utf8(payload).ok().map(str::to_owned),
        other => {
            let decoder = match other {
                TextEncoding::Utf16Le => UTF_16LE,
                TextEncoding::Utf16Be => UTF_16BE,
                TextEncoding::Gb18030 => GB18030,
                TextEncoding::Gbk => GBK,
                _ => unreachable!(),
            };
            decoder.decode_without_bom_handling_and_without_replacement(payload).map(|text| text.into_owned())
        }
    }.ok_or("文件不能用所选编码完整解码；原文件未修改 / Invalid bytes for this encoding; the source is unchanged.")?;
    if text.contains('\0') {
        return Err("文本包含空字符，请检查编码或文件类型 / Text contains NUL characters; check the encoding or file type.".into());
    }
    Ok((text, bom))
}
pub fn read(path: &Path, encoding: TextEncoding) -> Result<storage::DiskFile, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
        return Err("文件超过 32 MiB / File exceeds 32 MiB.".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let (text, bom) = decode(&bytes, encoding)?;
    Ok(storage::DiskFile {
        path: path.to_string_lossy().into_owned(),
        crlf: text.contains("\r\n"),
        content: text.replace("\r\n", "\n"),
        version: storage::version(&bytes),
        bom,
    })
}
pub fn serialize(file: &storage::DiskFile, encoding: TextEncoding) -> Result<Vec<u8>, String> {
    if file.content.contains('\0') {
        return Err("文本包含空字符，未保存 / Text contains NUL characters; not saved.".into());
    }
    let text = if file.crlf {
        file.content.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        file.content.clone()
    };
    let mut bytes = if file.bom {
        marker(encoding).to_vec()
    } else {
        Vec::new()
    };
    if file.bom && matches!(encoding, TextEncoding::Gbk | TextEncoding::Gb18030) {
        return Err("GBK/GB18030 不使用 BOM，请关闭 BOM 或另存为 UTF-8 / GBK and GB18030 do not support BOM.".into());
    }
    match encoding {
        TextEncoding::Utf8 => bytes.extend_from_slice(text.as_bytes()),
        TextEncoding::Utf16Le | TextEncoding::Utf16Be => {
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&if encoding == TextEncoding::Utf16Le {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
        }
        TextEncoding::Gbk | TextEncoding::Gb18030 => {
            let encoder = if encoding == TextEncoding::Gbk {
                GBK
            } else {
                GB18030
            };
            let (encoded, _, errors) = encoder.encode(&text);
            if errors {
                return Err("所选编码无法表示部分字符，请另存为 UTF-8；原文件未修改 / Some characters cannot be encoded; save as UTF-8 instead.".into());
            }
            bytes.extend_from_slice(&encoded);
        }
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(
            "编码后文件超过 32 MiB，未保存 / Encoded file exceeds 32 MiB; not saved.".into(),
        );
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn document_stamp(path: String, app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.state::<AppState>().check(Path::new(&path))?;
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("请选择文档文件 / Select a document file.".into());
        }
        let modified = metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            format!("{}:{}", metadata.dev(), metadata.ino())
        };
        #[cfg(not(unix))]
        let identity = String::new();
        Ok(format!(
            "{}:{modified}:{}:{identity}",
            metadata.len(),
            metadata.permissions().readonly()
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn read_with_encoding(
    path: String,
    encoding: TextEncoding,
    app: tauri::AppHandle,
) -> Result<EncodedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = app.state::<AppState>().check(Path::new(&path))?;
        Ok(EncodedDocument {
            file: read(&path, encoding)?,
            encoding,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn choose_file_for_encoding(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = state.allow_file(&file.into_path().map_err(|e| e.to_string())?)?;
    state.persist(&app)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file(text: &str, bom: bool) -> storage::DiskFile {
        storage::DiskFile {
            path: "test.md".into(),
            content: text.into(),
            version: String::new(),
            bom,
            crlf: true,
        }
    }
    #[test]
    fn unicode_encodings_keep_bom_and_crlf() {
        for encoding in [
            TextEncoding::Utf8,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16Be,
        ] {
            for bom in [false, true] {
                let bytes = serialize(&file("中文😀\n下一行", bom), encoding).unwrap();
                let (text, detected) = decode(&bytes, encoding).unwrap();
                assert_eq!(text, "中文😀\r\n下一行");
                assert_eq!(detected, bom);
            }
        }
    }
    #[test]
    fn chinese_encodings_roundtrip_and_gbk_never_substitutes() {
        for encoding in [TextEncoding::Gbk, TextEncoding::Gb18030] {
            let bytes = serialize(&file("中文\n文档", false), encoding).unwrap();
            assert_ne!(&bytes[..4], "中文".as_bytes().get(..4).unwrap());
            assert_eq!(decode(&bytes, encoding).unwrap().0, "中文\r\n文档");
        }
        assert!(serialize(&file("😀", false), TextEncoding::Gbk).is_err());
        let bytes = serialize(&file("😀", false), TextEncoding::Gb18030).unwrap();
        assert_eq!(decode(&bytes, TextEncoding::Gb18030).unwrap().0, "😀");
        assert!(serialize(&file("中文", true), TextEncoding::Gbk).is_err());
    }
    #[test]
    fn malformed_bytes_and_mismatched_bom_are_rejected() {
        assert!(decode(&[0xff], TextEncoding::Utf8).is_err());
        assert!(decode(&[0xff, 0xfe, 0x00], TextEncoding::Utf16Le).is_err());
        assert!(decode(&[0xff, 0xfe, 0x00, 0x61], TextEncoding::Utf16Be).is_err());
        assert!(decode(&[0x81], TextEncoding::Gbk).is_err());
        assert!(decode(&[0], TextEncoding::Utf8).is_err());
    }
    #[test]
    fn preview_does_not_write_and_encoded_save_keeps_version_conflicts() {
        let root = std::env::temp_dir().join(format!(
            "markwrite-encoding-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("中文.md");
        let bytes = serialize(&file("中文", false), TextEncoding::Gbk).unwrap();
        fs::write(&path, &bytes).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(read(&path, TextEncoding::Utf8).is_err());
        let mut doc = read(&path, TextEncoding::Gbk).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        doc.content.push_str("已编辑");
        storage::atomic_write(
            &path,
            &serialize(&doc, TextEncoding::Gbk).unwrap(),
            Some(&doc.version),
            &root.join("history"),
        )
        .unwrap();
        let old = crate::history::list(&root.join("history"), &path).unwrap();
        assert_eq!(
            crate::history::read_with_encoding(
                &root.join("history"),
                &path,
                &old[0].id,
                Some(TextEncoding::Gbk)
            )
            .unwrap()
            .content,
            "中文"
        );
        fs::write(&path, b"external").unwrap();
        assert!(storage::atomic_write(
            &path,
            &serialize(&doc, TextEncoding::Gbk).unwrap(),
            Some(&doc.version),
            &root.join("history")
        )
        .unwrap_err()
        .starts_with("CONFLICT:"));
        assert_eq!(fs::read(&path).unwrap(), b"external");
        fs::remove_dir_all(root).unwrap();
    }
}
