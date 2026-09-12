//! User-requested persistence in the OS credential store, never settings or backups.
use sha2::{Digest, Sha256};
fn account(endpoint: &str) -> Result<String, String> {
    let url =
        url::Url::parse(endpoint.trim()).map_err(|_| "无效的服务地址 / Invalid service URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请不要在地址中填写凭据 / Keep credentials out of URLs".into());
    }
    // Scope to exact endpoint; switching providers never sends a previous provider's key.
    Ok(format!("ai-{:x}", Sha256::digest(url.as_str().as_bytes())))
}
fn store_error(_: keyring::Error) -> String {
    "无法访问系统凭据库，请解锁登录密钥环后重试；仍可临时填写密钥使用。 / System credential store unavailable. Unlock your login keyring or use a temporary key.".into()
}
#[tauri::command]
pub async fn ai_load_key(endpoint: String) -> Result<Option<String>, String> {
    let account = account(&endpoint)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("app.markwrite.desktop", &account).map_err(store_error)?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    })
    .await
    .map_err(|_| "凭据读取任务失败 / Credential task failed".to_string())?
}
#[tauri::command]
pub async fn ai_save_key(endpoint: String, api_key: String) -> Result<(), String> {
    let account = account(&endpoint)?;
    if api_key.trim().is_empty() || api_key.len() > 8192 || api_key.chars().any(char::is_control) {
        return Err("密钥格式无效 / Invalid API key".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        keyring::Entry::new("app.markwrite.desktop", &account)
            .and_then(|entry| entry.set_password(api_key.trim()))
            .map_err(store_error)
    })
    .await
    .map_err(|_| "凭据保存任务失败 / Credential task failed".to_string())?
}
#[tauri::command]
pub async fn ai_delete_key(endpoint: String) -> Result<(), String> {
    let account = account(&endpoint)?;
    tauri::async_runtime::spawn_blocking(move || {
        match keyring::Entry::new("app.markwrite.desktop", &account)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    })
    .await
    .map_err(|_| "凭据删除任务失败 / Credential task failed".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes_keys_to_endpoint_without_retaining_plain_urls() {
        assert_eq!(
            account(" https://service.test/v1/chat/completions ").unwrap(),
            account("https://service.test/v1/chat/completions").unwrap()
        );
        assert_ne!(
            account("https://one.test/v1").unwrap(),
            account("https://two.test/v1").unwrap()
        );
        assert_ne!(
            account("https://one.test/tenant-a").unwrap(),
            account("https://one.test/tenant-b").unwrap()
        );
        assert!(!account("https://one.test/v1").unwrap().contains("one.test"));
        assert!(account("https://user:pass@one.test/v1").is_err());
    }
}
