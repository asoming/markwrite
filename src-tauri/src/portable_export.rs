//! Portable document export: copy only explicitly selected reference spans and approved files.
use crate::{storage, AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_CONTENT: usize = 32 * 1024 * 1024;
const MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_TOTAL: u64 = 128 * 1024 * 1024;
const MAX_RESOURCES: usize = 2000;
const MAX_FILES: usize = 500;
#[derive(Clone, Deserialize)]
pub struct Resource {
    from: usize,
    to: usize,
    source: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    index: usize,
    source: String,
    target: Option<String>,
    size: u64,
    status: String,
    message: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    id: String,
    document_name: String,
    assets: Vec<Asset>,
    total_bytes: u64,
}
#[derive(Clone)]
struct FileCopy {
    path: PathBuf,
    target: String,
    hash: String,
    size: u64,
}
#[derive(Clone)]
struct Plan {
    preview: Preview,
    document: PathBuf,
    content: String,
    edits: Vec<(usize, usize, String)>,
    files: Vec<FileCopy>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    path: String,
    asset_count: usize,
    skipped_count: usize,
}
static PLANS: OnceLock<Mutex<VecDeque<Plan>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
fn plans() -> &'static Mutex<VecDeque<Plan>> {
    PLANS.get_or_init(Mutex::default)
}
fn id() -> String {
    storage::version(
        format!(
            "{}:{:?}:{}",
            std::process::id(),
            std::time::SystemTime::now(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    )
}
fn clean_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(180)
        .collect();
    let name = name.trim_end_matches([' ', '.']);
    if name.is_empty() || crate::valid_name(name).is_err() {
        format!("attachment-{}", &storage::version(name.as_bytes())[..8])
    } else {
        name.into()
    }
}
fn utf16_ranges(content: &str, resources: &[Resource]) -> Result<Vec<(usize, usize)>, String> {
    if content.len() > MAX_CONTENT || resources.len() > MAX_RESOURCES {
        return Err(
            "文档或引用数量超过导出限制 / Document or references exceed export limits.".into(),
        );
    }
    let mut offsets = BTreeSet::new();
    for r in resources {
        if r.from >= r.to {
            return Err("引用范围无效 / Invalid reference range.".into());
        }
        offsets.insert(r.from);
        offsets.insert(r.to);
    }
    let mut byte_offsets = BTreeMap::new();
    let mut units = 0;
    for (byte, c) in content.char_indices() {
        if offsets.contains(&units) {
            byte_offsets.insert(units, byte);
        }
        units += c.len_utf16();
    }
    byte_offsets.insert(units, content.len());
    let mut ranges = Vec::new();
    for r in resources {
        let from = *byte_offsets
            .get(&r.from)
            .ok_or("引用起点无效 / Invalid reference start.")?;
        let to = *byte_offsets
            .get(&r.to)
            .ok_or("引用终点无效 / Invalid reference end.")?;
        if content.get(from..to) != Some(r.source.as_str()) {
            return Err(
                "文档已改变，请重新预览 / Reference does not match the previewed document.".into(),
            );
        }
        ranges.push((from, to));
    }
    let mut sorted = ranges.clone();
    sorted.sort_unstable();
    if sorted.windows(2).any(|v| v[0].1 > v[1].0) {
        return Err("引用范围重叠 / Reference ranges overlap.".into());
    }
    Ok(ranges)
}
fn unescape(source: &str) -> String {
    let mut result = String::new();
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|c| c.is_ascii_punctuation()) {
            result.push(chars.next().unwrap());
        } else {
            result.push(c);
        }
    }
    // Named entities that can occur in URL destinations; numeric entities cover other characters.
    let mut out = String::new();
    let mut rest = result.as_str();
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|end| *end <= 12).and_then(|end| {
            let entity = &rest[1..end];
            let value = match entity {
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "lt" => Some('<'),
                "gt" => Some('>'),
                _ => {
                    if let Some(n) = entity
                        .strip_prefix("#x")
                        .or_else(|| entity.strip_prefix("#X"))
                    {
                        u32::from_str_radix(n, 16).ok().and_then(char::from_u32)
                    } else {
                        entity
                            .strip_prefix('#')
                            .and_then(|n| n.parse().ok())
                            .and_then(char::from_u32)
                    }
                }
            };
            value.map(|value| (end, value))
        });
        if let Some((end, value)) = decoded {
            out.push(value);
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}
fn encode_suffix(suffix: &str) -> String {
    // The same replacement can occur in Markdown destinations or quoted HTML.
    // Preserve query/fragment semantics without creating a closing quote or bracket.
    const SYNTAX: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'\'')
        .add(b'<')
        .add(b'>')
        .add(b'(')
        .add(b')')
        .add(b'[')
        .add(b']')
        .add(b'\\')
        .add(b'`');
    percent_encoding::utf8_percent_encode(suffix, SYNTAX)
        .to_string()
        .replace('&', "&amp;")
}
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            value => out.push(value.as_os_str()),
        }
    }
    out
}
fn scoped_reference(
    doc: &Path,
    source: &str,
    roots: &[PathBuf],
) -> Result<(PathBuf, String), (&'static str, &'static str)> {
    let source = unescape(source);
    let (local, suffix) = source
        .find(['?', '#'])
        .map(|n| (&source[..n], &source[n..]))
        .unwrap_or((&source, ""));
    let decoded = percent_encoding::percent_decode_str(local)
        .decode_utf8()
        .map_err(|_| ("unsupported", "路径编码无效 / Invalid URL encoding."))?;
    if decoded.contains(':') || decoded.starts_with("//") || decoded.starts_with('\\') {
        return Err((
            "remote",
            "外部 URL 不下载 / External URLs are not downloaded.",
        ));
    }
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.chars().any(char::is_control)
        || decoded.contains('\\')
    {
        return Err((
            "unsupported",
            "仅支持本地相对路径 / Only local relative paths are supported.",
        ));
    }
    if Path::new(decoded.as_ref()).components().any(
        |part| matches!(part, Component::Normal(name) if name.to_string_lossy().starts_with('.')),
    ) {
        return Err((
            "unsupported",
            "隐藏附件不自动打包 / Hidden attachments are not packaged.",
        ));
    }
    let parent = doc
        .parent()
        .ok_or(("unsupported", "文档目录无效 / Invalid document directory."))?;
    let lexical = normalize(&parent.join(decoded.as_ref()));
    let allowed =
        |path: &Path| path.starts_with(parent) || roots.iter().any(|root| path.starts_with(root));
    if !allowed(&lexical) {
        return Err((
            "denied",
            "附件目录尚未授权 / Attachment directory has not been authorized.",
        ));
    }
    let canonical = lexical
        .canonicalize()
        .map_err(|_| ("missing", "找不到附件 / Attachment is unavailable."))?;
    if !allowed(&canonical) {
        return Err((
            "denied",
            "附件实际位置超出授权目录 / Attachment resolves outside authorized directories.",
        ));
    }
    let metadata = fs::metadata(&canonical)
        .map_err(|_| ("missing", "附件无法访问 / Attachment is inaccessible."))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err((
            "unsupported",
            "仅打包不超过 32 MiB 的文件 / Only files up to 32 MiB are included.",
        ));
    }
    Ok((canonical, suffix.into()))
}
fn file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err(
            "附件超过 32 MiB 或不再是文件 / Attachment exceeds 32 MiB or is not a file.".into(),
        );
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("附件超过 32 MiB / Attachment exceeds 32 MiB.".into());
    }
    Ok(bytes)
}
fn prepare(
    state: &AppState,
    path: &Path,
    content: String,
    resources: Vec<Resource>,
) -> Result<Plan, String> {
    let ranges = utf16_ranges(&content, &resources)?;
    let document = state.check(path)?;
    if !document.is_file() || !crate::is_markdown(&document) {
        return Err("请先打开 Markdown 文件 / Open a Markdown document first.".into());
    }
    let roots: Vec<_> = state
        .access
        .lock()
        .map_err(|e| e.to_string())?
        .roots
        .iter()
        .cloned()
        .collect();
    let mut files = Vec::<FileCopy>::new();
    let mut known = HashMap::<PathBuf, usize>::new();
    let mut assets = Vec::new();
    let mut edits = Vec::new();
    let mut total_bytes = content.len() as u64;
    for (index, (resource, (from, to))) in resources.into_iter().zip(ranges).enumerate() {
        let mut asset = Asset {
            index,
            source: resource.source.clone(),
            target: None,
            size: 0,
            status: "ready".into(),
            message: None,
        };
        match scoped_reference(&document, &resource.source, &roots) {
            Ok((path, suffix)) => {
                let file_index = if let Some(index) = known.get(&path) {
                    *index
                } else {
                    if files.len() >= MAX_FILES {
                        return Err(
                            "最多打包 500 个附件 / At most 500 attachments can be exported.".into(),
                        );
                    }
                    let bytes = file_bytes(&path)?;
                    let size = bytes.len() as u64;
                    total_bytes += size;
                    if total_bytes > MAX_TOTAL {
                        return Err(
                            "文档与附件超过 128 MiB / Document and attachments exceed 128 MiB."
                                .into(),
                        );
                    }
                    let index = files.len();
                    let basename =
                        clean_name(&path.file_name().unwrap_or_default().to_string_lossy());
                    files.push(FileCopy {
                        path: path.clone(),
                        target: format!("assets/{:03}/{basename}", index + 1),
                        hash: storage::version(&bytes),
                        size,
                    });
                    known.insert(path, index);
                    index
                };
                let file = &files[file_index];
                asset.target = Some(file.target.clone());
                asset.size = file.size;
                let encoded = percent_encoding::utf8_percent_encode(
                    &file.target,
                    percent_encoding::NON_ALPHANUMERIC,
                )
                .to_string()
                .replace("%2F", "/")
                .replace("%2D", "-")
                .replace("%2E", ".")
                .replace("%5F", "_");
                edits.push((from, to, format!("{encoded}{}", encode_suffix(&suffix))));
            }
            Err((status, message)) => {
                asset.status = status.into();
                asset.message = Some(message.into());
            }
        }
        assets.push(asset);
    }
    let document_name = clean_name(&document.file_name().unwrap_or_default().to_string_lossy());
    Ok(Plan {
        preview: Preview {
            id: id(),
            document_name,
            assets,
            total_bytes,
        },
        document,
        content,
        files,
        edits,
    })
}
fn archive_bytes(plan: &Plan, skip: bool) -> Result<Vec<u8>, String> {
    if !skip
        && plan
            .preview
            .assets
            .iter()
            .any(|asset| asset.status != "ready")
    {
        return Err("存在无法打包的附件，请确认跳过或返回修复 / Confirm skipping unavailable attachments or fix them first.".into());
    }
    let mut content = plan.content.clone();
    let mut edits = plan.edits.clone();
    edits.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    for (from, to, target) in edits {
        content.replace_range(from..to, &target);
    }
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    archive
        .start_file(&plan.preview.document_name, options)
        .map_err(|e| e.to_string())?;
    archive
        .write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    for file in &plan.files {
        // Re-canonicalization prevents a replaced symlink from turning a grant into an arbitrary read.
        if file.path.canonicalize().map_err(|e| e.to_string())? != file.path {
            return Err(
                "附件位置已改变，请重新预览 / Attachment location changed; preview again.".into(),
            );
        }
        let bytes = file_bytes(&file.path)?;
        if storage::version(&bytes) != file.hash {
            return Err(
                "附件在预览后已改变，请重新预览 / Attachment changed after preview; preview again."
                    .into(),
            );
        }
        archive
            .start_file(&file.target, options)
            .map_err(|e| e.to_string())?;
        archive.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    let manifest = serde_json::json!({"format":"Markwrite portable document","version":1,"encoding":"UTF-8","document":plan.preview.document_name,"assets":plan.preview.assets});
    archive
        .start_file("markwrite-manifest.json", options)
        .map_err(|e| e.to_string())?;
    archive
        .write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(archive.finish().map_err(|e| e.to_string())?.into_inner())
}
fn export_to(
    plan: &Plan,
    destination: &Path,
    skip: bool,
    recovery: &Path,
) -> Result<Saved, String> {
    let destination = destination
        .parent()
        .ok_or("导出目录无效 / Invalid export directory.")?
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(
            destination
                .file_name()
                .ok_or("导出名称无效 / Invalid export name.")?,
        );
    if destination
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|ext| !ext.eq_ignore_ascii_case("zip"))
    {
        return Err("导出文件需要 .zip 扩展名 / Export filename must end in .zip.".into());
    }
    if destination
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(
            "导出目标不能是符号链接 / Export destination cannot be a symbolic link.".into(),
        );
    }
    // Canonicalizing an existing output also resolves case aliases on Windows.
    let identity = destination
        .canonicalize()
        .unwrap_or_else(|_| destination.clone());
    if identity == plan.document || plan.files.iter().any(|file| file.path == identity) {
        return Err("不能覆盖原文或附件 / Cannot replace a source document or attachment.".into());
    }
    let bytes = archive_bytes(plan, skip)?;
    storage::atomic_write(&destination, &bytes, None, recovery)?;
    Ok(Saved {
        path: destination.to_string_lossy().into_owned(),
        asset_count: plan.files.len(),
        skipped_count: plan
            .preview
            .assets
            .iter()
            .filter(|a| a.status != "ready")
            .count(),
    })
}
#[tauri::command]
pub async fn prepare_portable(
    path: String,
    content: String,
    resources: Vec<Resource>,
    app: tauri::AppHandle,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let plan = prepare(
            &app.state::<AppState>(),
            Path::new(&path),
            content,
            resources,
        )?;
        let preview = plan.preview.clone();
        let mut plans = plans().lock().map_err(|e| e.to_string())?;
        while plans.len() >= 4 {
            plans.pop_front();
        }
        plans.push_back(plan);
        Ok(preview)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn discard_portable(id: String) -> Result<(), String> {
    plans()
        .lock()
        .map_err(|e| e.to_string())?
        .retain(|plan| plan.preview.id != id);
    Ok(())
}
#[tauri::command]
pub async fn save_portable(
    id: String,
    skip_unavailable: bool,
    app: tauri::AppHandle,
) -> Result<Option<Saved>, String> {
    let plan = plans()
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|plan| plan.preview.id == id)
        .cloned()
        .ok_or("预览已过期，请重新预览 / Preview expired; preview again.")?;
    if !skip_unavailable
        && plan
            .preview
            .assets
            .iter()
            .any(|asset| asset.status != "ready")
    {
        return Err("请确认跳过无法打包的附件 / Confirm skipping unavailable attachments.".into());
    }
    let name = format!(
        "{}.zip",
        Path::new(&plan.preview.document_name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
    );
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("ZIP", &["zip"])
        .set_file_name(name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let recovery = crate::recovery(&app)?;
    let saved = tauri::async_runtime::spawn_blocking(move || {
        export_to(&plan, &path, skip_unavailable, &recovery)
    })
    .await
    .map_err(|e| e.to_string())??;
    discard_portable(id)?;
    Ok(Some(saved))
}
#[tauri::command]
pub async fn authorize_asset_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let directory = folder
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    let added = state
        .access
        .lock()
        .map_err(|e| e.to_string())?
        .roots
        .insert(directory.clone());
    if let Err(error) = state.persist(&app) {
        if added {
            state
                .access
                .lock()
                .map_err(|e| e.to_string())?
                .roots
                .remove(&directory);
        }
        return Err(error);
    }
    Ok(Some(directory.to_string_lossy().into_owned()))
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        dir: PathBuf,
        doc: PathBuf,
        state: AppState,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("markwrite-portable-{}", id()));
            fs::create_dir_all(dir.join("docs/assets")).unwrap();
            let doc = dir.join("docs/中文文档.md");
            fs::write(&doc, b"source must not change\r\n").unwrap();
            let state = AppState::default();
            state.allow_file(&doc).unwrap();
            Self { dir, doc, state }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    fn resource(content: &str, source: &str) -> Resource {
        let from = content.find(source).unwrap();
        Resource {
            from: content[..from].encode_utf16().count(),
            to: content[..from + source.len()].encode_utf16().count(),
            source: source.into(),
        }
    }
    fn member(bytes: &[u8], path: &str) -> Vec<u8> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut bytes = Vec::new();
        zip.by_name(path).unwrap().read_to_end(&mut bytes).unwrap();
        bytes
    }
    #[test]
    fn copies_unicode_attachments_and_rewrites_only_requested_spans_without_changing_sources() {
        let f = Fixture::new();
        let image = f.dir.join("docs/assets/图 像.png");
        let attachment = f.dir.join("说明.pdf");
        fs::write(&image, [1, 2, 3]).unwrap();
        fs::write(&attachment, b"PDF").unwrap();
        f.state.access.lock().unwrap().roots.insert(f.dir.clone());
        let original = fs::read(&f.doc).unwrap();
        let modified = fs::metadata(&f.doc).unwrap().modified().unwrap();
        let image_time = fs::metadata(&image).unwrap().modified().unwrap();
        let content =
            "😀 ![图](assets/图%20像.png)\n[附件](../说明.pdf#page=2)\n`assets/图%20像.png`\n";
        let plan = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![
                resource(content, "assets/图%20像.png"),
                resource(content, "../说明.pdf#page=2"),
            ],
        )
        .unwrap();
        assert_eq!(plan.files.len(), 2);
        assert!(plan.preview.assets.iter().all(|a| a.status == "ready"));
        let output = f.dir.join("export.zip");
        let saved = export_to(&plan, &output, false, &f.dir.join("recovery")).unwrap();
        assert_eq!(saved.asset_count, 2);
        let bytes = fs::read(output).unwrap();
        assert_eq!(member(&bytes, &plan.files[0].target), vec![1, 2, 3]);
        assert_eq!(member(&bytes, &plan.files[1].target), b"PDF");
        let text = String::from_utf8(member(&bytes, &plan.preview.document_name)).unwrap();
        assert!(text.starts_with("😀 ![图](assets/001/"));
        assert!(text.contains("#page=2"));
        assert!(text.contains("`assets/图%20像.png`"));
        assert_eq!(fs::read(&f.doc).unwrap(), original);
        assert_eq!(fs::metadata(&f.doc).unwrap().modified().unwrap(), modified);
        assert_eq!(
            fs::metadata(&image).unwrap().modified().unwrap(),
            image_time
        );
        let archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(archive.file_names().all(|name| !name.starts_with('/')
            && !name.contains('\\')
            && Path::new(name)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))));
    }
    #[test]
    fn missing_remote_and_outside_resources_require_explicit_skip() {
        let f = Fixture::new();
        fs::write(f.dir.join("private.pdf"), b"secret").unwrap();
        let content="[a](missing.png) [b](https://example.invalid/a.png) [c](../private.pdf) [d](../../../../etc/passwd)";
        let refs = [
            "missing.png",
            "https://example.invalid/a.png",
            "../private.pdf",
            "../../../../etc/passwd",
        ]
        .iter()
        .map(|s| resource(content, s))
        .collect();
        let plan = prepare(&f.state, &f.doc, content.into(), refs).unwrap();
        assert_eq!(
            plan.preview
                .assets
                .iter()
                .map(|a| a.status.as_str())
                .collect::<Vec<_>>(),
            vec!["missing", "remote", "denied", "denied"]
        );
        assert!(archive_bytes(&plan, false).is_err());
        let bytes = archive_bytes(&plan, true).unwrap();
        assert_eq!(
            member(&bytes, &plan.preview.document_name),
            content.as_bytes()
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&member(&bytes, "markwrite-manifest.json")).unwrap();
        assert_eq!(manifest["assets"][2]["status"], "denied");
    }
    #[test]
    fn invalid_spans_are_rejected_before_reading_any_asset() {
        let f = Fixture::new();
        let content = "😀 [a](a.png)";
        let valid = resource(content, "a.png");
        for resources in [
            vec![Resource {
                from: 1,
                to: 2,
                source: "x".into(),
            }],
            vec![Resource {
                source: "different.png".into(),
                ..valid.clone()
            }],
            vec![valid.clone(), valid],
        ] {
            assert!(prepare(&f.state, &f.doc, content.into(), resources).is_err());
        }
    }
    #[test]
    fn changed_assets_or_source_export_targets_leave_existing_bytes_untouched() {
        let f = Fixture::new();
        let asset = f.dir.join("docs/assets/archive.zip");
        fs::write(&asset, b"first").unwrap();
        let content = "[zip](assets/archive.zip)";
        let plan = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![resource(content, "assets/archive.zip")],
        )
        .unwrap();
        assert!(export_to(&plan, &asset, false, &f.dir.join("recovery")).is_err());
        assert_eq!(fs::read(&asset).unwrap(), b"first");
        let output = f.dir.join("export.zip");
        fs::write(&output, b"existing").unwrap();
        fs::write(&asset, b"changed").unwrap();
        assert!(export_to(&plan, &output, false, &f.dir.join("recovery")).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"existing");
    }
    #[test]
    fn escaped_destinations_and_duplicate_attachments_are_supported() {
        let f = Fixture::new();
        fs::write(f.dir.join("docs/assets/a (1)&b.pdf"), b"asset").unwrap();
        let content = "[a](assets/a%20\\(1\\)&amp;b.pdf) [b](assets/a%20%281%29%26b.pdf)";
        let plan = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![
                resource(content, "assets/a%20\\(1\\)&amp;b.pdf"),
                resource(content, "assets/a%20%281%29%26b.pdf"),
            ],
        )
        .unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.preview.assets.len(), 2);
        assert_eq!(plan.edits.len(), 2);
        assert_eq!(plan.preview.total_bytes, content.len() as u64 + 5);
    }
    #[test]
    fn query_fragments_cannot_break_the_destination_markup() {
        let f = Fixture::new();
        fs::write(f.dir.join("docs/assets/a.png"), b"image").unwrap();
        let content = "<img src=\"assets/a.png?q=&quot;&amp;x=2#part\\)\">";
        let plan = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![resource(content, "assets/a.png?q=&quot;&amp;x=2#part\\)")],
        )
        .unwrap();
        let bytes = archive_bytes(&plan, false).unwrap();
        let exported = String::from_utf8(member(&bytes, &plan.preview.document_name)).unwrap();
        assert_eq!(
            exported,
            "<img src=\"assets/001/a.png?q=%22&amp;x=2#part%29\">"
        );
    }
    #[test]
    fn oversize_and_hidden_resources_are_reported_without_loading_them() {
        let f = Fixture::new();
        let huge = fs::File::create(f.dir.join("docs/huge.bin")).unwrap();
        huge.set_len(MAX_FILE + 1).unwrap();
        fs::write(f.dir.join("docs/.env"), b"secret").unwrap();
        let content = "[a](huge.bin) [b](.env)";
        let plan = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![resource(content, "huge.bin"), resource(content, ".env")],
        )
        .unwrap();
        assert!(plan.files.is_empty());
        assert!(plan
            .preview
            .assets
            .iter()
            .all(|a| a.status == "unsupported"));
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_authorized_directories_or_change_after_preview() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.dir.join("secret.pdf");
        fs::write(&outside, b"secret").unwrap();
        let linked = f.dir.join("docs/assets/link.pdf");
        symlink(&outside, &linked).unwrap();
        let content = "[a](assets/link.pdf)";
        let denied = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![resource(content, "assets/link.pdf")],
        )
        .unwrap();
        assert_eq!(denied.preview.assets[0].status, "denied");
        fs::remove_file(&linked).unwrap();
        fs::write(&linked, b"safe").unwrap();
        let ready = prepare(
            &f.state,
            &f.doc,
            content.into(),
            vec![resource(content, "assets/link.pdf")],
        )
        .unwrap();
        fs::remove_file(&linked).unwrap();
        symlink(&outside, &linked).unwrap();
        assert!(archive_bytes(&ready, false).is_err());
    }
}
