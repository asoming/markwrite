//! Explicit release checks and verified downloads. Never executes an installer or stores tokens.
use reqwest::{header, Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, time::Duration};
use tauri::{Emitter, Manager};
const API: &str = "https://api.github.com/repos/asoming/markwrite";
const PAGE: &str = "https://github.com/asoming/markwrite/releases";
const LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
pub struct Asset {
    id: u64,
    name: String,
    size: u64,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    id: u64,
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: Option<String>,
    available: bool,
    release_id: Option<u64>,
    notes: String,
    url: String,
    asset: Option<Asset>,
}
fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("Markwrite/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}
fn request(
    client: &Client,
    url: &str,
    token: Option<&str>,
    binary: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let mut request = client
        .get(url)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header(
            header::ACCEPT,
            if binary {
                "application/octet-stream"
            } else {
                "application/vnd.github+json"
            },
        );
    if let Some(token) = token.filter(|v| !v.trim().is_empty()) {
        if token.len() > 512 || token.chars().any(char::is_control) {
            return Err("令牌格式无效 / Invalid token".into());
        }
        request = request.bearer_auth(token.trim());
    }
    Ok(request)
}
fn status(response: &Response) -> Result<(), String> {
    match response.status().as_u16() {
        200..=299 => Ok(()),
        401 | 403 | 404 => Err("无法访问发布仓库。私有仓库需要 Contents 只读令牌；也可在浏览器登录 GitHub 后下载。 / Release access unavailable. Use a read-only token for a private repository, or download in your signed-in browser.".into()),
        code => Err(format!("更新请求失败 / Update request failed: HTTP {code}")),
    }
}
async fn bytes(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    status(&response)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("更新响应超过限制 / Update response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.trim_start_matches('v')).ok()
}
fn choose(releases: Vec<Release>, previews: bool) -> Option<Release> {
    releases
        .into_iter()
        .filter(|r| !r.draft && (previews || !r.prerelease) && version(&r.tag_name).is_some())
        .max_by_key(|r| version(&r.tag_name).unwrap())
}
fn installer(release: &Release, os: &str, arch: &str) -> Option<Asset> {
    if arch != "x86_64" {
        return None;
    }
    let v = version(&release.tag_name)?.to_string();
    let name = match os {
        "linux" => format!("Markwrite_{v}_amd64.deb"),
        "windows" => format!("Markwrite_{v}_x64-setup.exe"),
        _ => return None,
    };
    release
        .assets
        .iter()
        .find(|a| a.name == name && a.size > 0 && a.size <= LIMIT)
        .cloned()
}
#[tauri::command]
pub async fn check_app_update(token: Option<String>, previews: bool) -> Result<UpdateInfo, String> {
    let client = client()?;
    let response = request(
        &client,
        &format!("{API}/releases?per_page=100"),
        token.as_deref(),
        false,
    )?
    .send()
    .await
    .map_err(|e| e.to_string())?;
    let releases: Vec<Release> = serde_json::from_slice(&bytes(response, 4 * 1024 * 1024).await?)
        .map_err(|_| "发布数据无效 / Invalid release metadata")?;
    let current = env!("CARGO_PKG_VERSION").to_owned();
    let selected = choose(releases, previews);
    if let Some(release) = selected {
        let asset = installer(&release, std::env::consts::OS, std::env::consts::ARCH);
        Ok(UpdateInfo {
            available: version(&release.tag_name) > version(&current),
            current,
            latest: Some(release.tag_name.clone()),
            release_id: Some(release.id),
            notes: release
                .body
                .unwrap_or_default()
                .chars()
                .take(30_000)
                .collect(),
            url: format!("{PAGE}/tag/{}", release.tag_name),
            asset,
        })
    } else {
        Ok(UpdateInfo {
            current,
            latest: None,
            available: false,
            release_id: None,
            notes: String::new(),
            url: PAGE.into(),
            asset: None,
        })
    }
}
fn download_host(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some(
                "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "github.com"
                    | "api.github.com"
            )
        )
}
async fn asset_response(client: &Client, id: u64, token: Option<&str>) -> Result<Response, String> {
    let mut response = request(client, &format!("{API}/releases/assets/{id}"), token, true)?
        .send()
        .await
        .map_err(|e| e.to_string())?;
    for _ in 0..4 {
        if !response.status().is_redirection() {
            status(&response)?;
            return Ok(response);
        }
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or("下载重定向无效 / Invalid download redirect")?;
        let url =
            reqwest::Url::parse(location).map_err(|_| "下载地址无效 / Invalid download URL")?;
        if !download_host(&url) {
            return Err("下载地址不属于 GitHub 发布存储 / Unexpected download host".into());
        }
        // Authentication is never forwarded to a signed asset URL on another host.
        response = client.get(url).send().await.map_err(|e| e.to_string())?;
    }
    Err("下载重定向过多 / Too many redirects".into())
}
fn expected_checksum(text: &str, name: &str) -> Result<String, String> {
    let mut found = None;
    for line in text.lines() {
        let Some((hash, filename)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if filename.trim().trim_start_matches('*') != name {
            continue;
        }
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || found.is_some() {
            return Err("校验文件无效 / Invalid checksum file".into());
        }
        found = Some(hash.to_lowercase());
    }
    found.ok_or_else(|| "发布缺少安装包校验值 / Installer checksum missing".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    path: String,
    name: String,
    sha256: String,
}
#[tauri::command]
pub async fn download_app_update(
    release_id: u64,
    token: Option<String>,
    app: tauri::AppHandle,
) -> Result<Downloaded, String> {
    let client = client()?;
    let response = request(
        &client,
        &format!("{API}/releases/{release_id}"),
        token.as_deref(),
        false,
    )?
    .send()
    .await
    .map_err(|e| e.to_string())?;
    let release: Release = serde_json::from_slice(&bytes(response, 4 * 1024 * 1024).await?)
        .map_err(|_| "发布数据无效 / Invalid release metadata")?;
    if release.draft || version(&release.tag_name) <= version(env!("CARGO_PKG_VERSION")) {
        return Err("这个发布不是新版本 / This release is not newer".into());
    }
    let asset = installer(&release, std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("没有当前系统的安装包 / No installer for this platform")?;
    let v = version(&release.tag_name).unwrap();
    let sums = release
        .assets
        .iter()
        .find(|a| a.name == format!("SHA256SUMS-{v}.txt") && a.size <= 65536)
        .ok_or("发布缺少校验文件 / Checksum file missing")?;
    let text = String::from_utf8(
        bytes(
            asset_response(&client, sums.id, token.as_deref()).await?,
            65536,
        )
        .await?,
    )
    .map_err(|_| "校验文件编码无效 / Invalid checksum encoding")?;
    let expected = expected_checksum(&text, &asset.name)?;
    if asset
        .digest
        .as_ref()
        .is_some_and(|d| d != &format!("sha256:{expected}"))
    {
        return Err("发布校验信息不一致 / Release digests disagree".into());
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temp = directory.join(format!(
        "{}-{}.part",
        asset.name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = async {
        let mut response = asset_response(&client, asset.id, token.as_deref()).await?;
        let mut total = 0u64;
        let mut hash = Sha256::new();
        let mut last_percent = 0;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            total += chunk.len() as u64;
            if total > asset.size || total > LIMIT {
                return Err("下载超过声明大小 / Download exceeds declared size".into());
            }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            hash.update(&chunk);
            let percent = total * 100 / asset.size;
            if percent != last_percent {
                let _ = app.emit("update-download-progress", percent);
                last_percent = percent;
            }
        }
        let actual = format!("{:x}", hash.finalize());
        if total != asset.size || actual != expected {
            return Err("下载校验失败，请重新下载 / Download verification failed".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(actual)
    }
    .await;
    drop(file);
    match result {
        Ok(sha256) => {
            let path = directory.join(&asset.name);
            crate::storage::replace_file(&temp, &path).map_err(|e| e.to_string())?;
            Ok(Downloaded {
                path: path.to_string_lossy().into_owned(),
                name: asset.name,
                sha256,
            })
        }
        Err(error) => {
            let _ = fs::remove_file(temp);
            Err(error)
        }
    }
}
#[tauri::command]
pub async fn open_update_folder(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    if !path.is_dir() {
        return Err("请先下载安装包 / Download an installer first".into());
    }
    open::that(path).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, prerelease: bool) -> Release {
        Release {
            id: 1,
            tag_name: tag.into(),
            body: None,
            draft: false,
            prerelease,
            assets: vec![],
        }
    }
    #[test]
    fn selects_semantic_versions_and_preview_channel() {
        assert_eq!(
            choose(
                vec![release("v0.9.0", false), release("v0.10.0", false)],
                false
            )
            .unwrap()
            .tag_name,
            "v0.10.0"
        );
        assert_eq!(
            choose(
                vec![release("v0.10.0", false), release("v1.0.0-beta.2", true)],
                false
            )
            .unwrap()
            .tag_name,
            "v0.10.0"
        );
        assert!(choose(vec![release("invalid", false)], true).is_none());
    }
    #[test]
    fn verifies_exact_checksum_filename_and_rejects_duplicates() {
        let hash = "a".repeat(64);
        assert_eq!(
            expected_checksum(&format!("{hash}  app.deb\n"), "app.deb").unwrap(),
            hash
        );
        assert!(expected_checksum(&format!("{hash}  other.deb"), "app.deb").is_err());
        assert!(expected_checksum(&format!("{hash} app.deb\n{hash} app.deb"), "app.deb").is_err());
    }
    #[test]
    fn rejects_non_github_redirects_and_wrong_installers() {
        for url in [
            "http://github.com/x",
            "https://github.com.evil.test/x",
            "https://user:pass@github.com/x",
        ] {
            assert!(!download_host(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(download_host(
            &reqwest::Url::parse("https://release-assets.githubusercontent.com/path?sig=abc")
                .unwrap()
        ));
        assert!(installer(&release("v1.0.0", false), "linux", "aarch64").is_none());
    }
}
