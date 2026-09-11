//! Explicit, optional HTTP adapters. These commands have no background callers,
//! never persist credentials, follow redirects, retry, or modify source files.
use reqwest::{header, multipart, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;
const IMAGE_LIMIT: usize = 20 * 1024 * 1024;
const HTML_LIMIT: usize = 32 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUpload {
    endpoint: String,
    #[serde(default)]
    api_key: String,
    name: String,
    bytes: Vec<u8>,
    #[serde(default)]
    response_path: String,
    #[serde(default)]
    field_name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPublish {
    endpoint: String,
    #[serde(default)]
    api_key: String,
    html: String,
    name: String,
    #[serde(default)]
    response_path: String,
}
#[derive(Serialize)]
pub struct TransferResult {
    url: String,
}
fn endpoint(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "服务地址无效，请输入完整的 HTTPS 地址。")?;
    let local = url
        .host_str()
        .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "[::1]");
    if url.host_str().is_none() || (url.scheme() != "https" && !(url.scheme() == "http" && local)) {
        return Err(
            "远程服务必须使用 HTTPS；本机服务可使用 localhost、127.0.0.1 或 [::1] HTTP。".into(),
        );
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("服务地址不能含用户名、密码或 # 片段；令牌请填入 API 密钥框。".into());
    }
    Ok(url)
}
fn response_path(value: &str) -> Result<Vec<String>, String> {
    if value.chars().any(char::is_control) {
        return Err("响应字段不能含控制字符。".into());
    }
    let value = value.trim();
    let value = if value.is_empty() { "url" } else { value };
    if value.len() > 256 {
        return Err("响应字段路径过长。".into());
    }
    let parts: Vec<String> = value.split('.').map(str::to_owned).collect();
    if parts.len() > 16
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
    {
        return Err("响应字段请使用 data.url 或 data.0.url 这样的点分路径。".into());
    }
    Ok(parts)
}
fn filename(value: &str) -> Result<String, String> {
    let name = value.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() || name.len() > 255 || name.chars().any(char::is_control) {
        return Err("文件名称无效或过长。".into());
    }
    Ok(name.to_owned())
}
fn token(value: &str) -> Result<(), String> {
    if value.len() > 16384 || value.chars().any(char::is_control) {
        return Err("API 密钥不能含控制字符，长度不能超过 16KB。".into());
    }
    Ok(())
}
fn result_url(
    base: &Url,
    body: &[u8],
    location: Option<&str>,
    path: &[String],
) -> Result<String, String> {
    let value: Option<serde_json::Value> = serde_json::from_slice(body).ok();
    let mut selected = value.as_ref();
    for component in path {
        selected = selected.and_then(|value| {
            if let Some(array) = value.as_array() {
                component.parse::<usize>().ok().and_then(|i| array.get(i))
            } else {
                value.get(component)
            }
        });
    }
    let link = selected
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .or(location)
        .ok_or("服务未返回可用 URL。请检查响应字段路径，或配置服务返回 Location 头。")?;
    if link.len() > 8192 || link.chars().any(char::is_control) {
        return Err("服务返回的 URL 无效或过长。".into());
    }
    let url = base
        .join(link.trim())
        .map_err(|_| "服务返回的 URL 无效。")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("服务返回了不安全的 URL，仅接受不含凭据的 HTTP(S) 地址。".into());
    }
    Ok(url.into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化 HTTP 连接。".into())
}
async fn finish(
    mut response: reqwest::Response,
    base: &Url,
    path: &[String],
) -> Result<TransferResult, String> {
    if !response.status().is_success() {
        return Err(format!(
            "服务返回 HTTP {}；不会自动重试或跳转，请检查服务地址与权限。",
            response.status().as_u16()
        ));
    }
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "响应读取失败；请在服务端确认是否已收到内容，避免重复提交。")?
    {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err("服务响应超过 2MB；请在服务端确认结果，避免重复提交。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    result_url(base, &bytes, location.as_deref(), path).map(|url| TransferResult { url })
}
#[tauri::command]
pub async fn upload_image(request: ImageUpload) -> Result<TransferResult, String> {
    let endpoint = endpoint(&request.endpoint)?;
    token(&request.api_key)?;
    let path = response_path(&request.response_path)?;
    let name = filename(&request.name)?;
    if request.bytes.is_empty() || request.bytes.len() > IMAGE_LIMIT {
        return Err("图片必须在 1 字节至 20MB 之间。".into());
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return Err("只支持 PNG、JPEG、GIF、WebP、AVIF 图片。".into()),
    };
    let field = if request.field_name.trim().is_empty() {
        "file"
    } else {
        request.field_name.trim()
    };
    if field.len() > 128
        || !field
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("上传字段名称只能使用英文字母、数字、下划线或连字符。".into());
    }
    let part = multipart::Part::bytes(request.bytes)
        .file_name(name)
        .mime_str(mime)
        .map_err(|_| "无法构建图片上传内容。")?;
    let form = multipart::Form::new().part(field.to_owned(), part);
    let mut builder = client()?.post(endpoint.clone()).multipart(form);
    if !request.api_key.is_empty() {
        builder = builder.bearer_auth(request.api_key);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "上传连接失败或超时；请先在服务端确认是否已收到图片，避免重复上传。")?;
    finish(response, &endpoint, &path).await
}
#[tauri::command]
pub async fn publish_html(request: HtmlPublish) -> Result<TransferResult, String> {
    let endpoint = endpoint(&request.endpoint)?;
    token(&request.api_key)?;
    let path = response_path(&request.response_path)?;
    let name = filename(&request.name)?;
    if request.html.is_empty() || request.html.len() > HTML_LIMIT {
        return Err("HTML 必须在 1 字节至 32MB 之间。".into());
    }
    let encoded_name =
        percent_encoding::utf8_percent_encode(&name, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    let mut builder = client()?
        .post(endpoint.clone())
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("X-Markwrite-Filename", encoded_name)
        .body(request.html);
    if !request.api_key.is_empty() {
        builder = builder.bearer_auth(request.api_key);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "发布连接失败或超时；请先在服务端确认是否已收到文档，避免重复发布。")?;
    finish(response, &endpoint, &path).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_require_secure_remote_or_explicit_local_http() {
        for address in [
            "https://example.com/upload",
            "http://localhost:8080/upload",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(endpoint(address).is_ok(), "{address}");
        }
        for address in [
            "http://example.com/upload",
            "file:///tmp/test",
            "javascript:alert(1)",
            "https://user:secret@example.com",
            "https://example.com/#secret",
        ] {
            assert!(endpoint(address).is_err(), "{address}");
        }
    }
    #[test]
    fn response_field_resolves_nested_array_and_location() {
        let base = endpoint("https://example.com/api/upload").unwrap();
        let nested = br#"{"data":[{"url":"/assets/image.png"}]}"#;
        assert_eq!(
            result_url(&base, nested, None, &response_path("data.0.url").unwrap()).unwrap(),
            "https://example.com/assets/image.png"
        );
        assert_eq!(
            result_url(
                &base,
                b"",
                Some("https://cdn.example.com/page"),
                &response_path("").unwrap()
            )
            .unwrap(),
            "https://cdn.example.com/page"
        );
        assert!(result_url(
            &base,
            br#"{"url":"javascript:alert(1)"}"#,
            None,
            &response_path("").unwrap()
        )
        .is_err());
        assert!(result_url(
            &base,
            br#"{"url":"data:text/html,bad"}"#,
            None,
            &response_path("").unwrap()
        )
        .is_err());
        assert!(result_url(
            &base,
            br#"{"url":"https://user:secret@example.com/"}"#,
            None,
            &response_path("").unwrap()
        )
        .is_err());
    }
    #[test]
    fn invalid_paths_and_header_characters_fail_before_request() {
        for path in ["data..url", ".url", "data[0].url", "data.url\n"] {
            assert!(response_path(path).is_err(), "{path:?}");
        }
        assert!(token("secret\r\nx-injected: yes").is_err());
        assert!(filename("evil\nname.png").is_err());
        assert_eq!(filename("C:\\documents\\图片.png").unwrap(), "图片.png");
    }
}
