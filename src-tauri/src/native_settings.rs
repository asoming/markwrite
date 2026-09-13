//! OS integration is opt-in: status is read-only; only request_markdown_default mutates registration.
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::{fs, io::Write};
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[cfg(target_os = "linux")]
use tauri::Manager;
#[derive(Serialize)]
pub struct MimeHandler {
    r#type: String,
    application: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultStatus {
    platform: String,
    is_default: Option<bool>,
    handlers: Vec<MimeHandler>,
    can_request: bool,
    message: String,
}
fn output(mut command: Command) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            let result = child.wait_with_output().map_err(|e| e.to_string())?;
            return if result.status.success() {
                Ok(String::from_utf8_lossy(&result.stdout).trim().to_string())
            } else {
                Err("系统工具未能完成操作，请检查权限或在系统设置中手动选择。".into())
            };
        }
        if start.elapsed() > Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("系统设置查询超时，请重试或打开系统设置。".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[cfg(any(target_os = "linux", test))]
fn desktop_exec(path: &Path) -> Result<String, String> {
    let path = path
        .to_str()
        .ok_or("应用路径不是有效 UTF-8，请移动应用后重试。")?;
    if path.contains('=') || path.chars().any(char::is_control) {
        return Err("此安装路径不适合桌面启动器，请把应用移到普通目录。".into());
    }
    let mut escaped = String::new();
    for character in path.chars() {
        match character {
            '\\' => escaped.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                escaped.push_str("\\\\");
                escaped.push(character);
            }
            '%' => escaped.push_str("%%"),
            _ => escaped.push(character),
        }
    }
    Ok(format!("\"{escaped}\" %F"))
}
#[cfg(any(target_os = "linux", test))]
fn desktop_entry(executable: &Path, icon: &Path) -> Result<String, String> {
    let icon = icon.to_str().ok_or("图标路径无效。")?;
    if icon.chars().any(char::is_control) {
        return Err("图标路径包含控制字符。".into());
    }
    Ok(format!("[Desktop Entry]\nVersion=1.0\nType=Application\nName=Markwrite\nComment=Local-first Markdown editor\nExec={}\nIcon={}\nTerminal=false\nCategories=Office;Utility;TextEditor;\nMimeType=text/markdown;text/x-markdown;\nStartupNotify=true\nStartupWMClass=markwrite\n",desktop_exec(executable)?,icon.replace('\\',"\\\\")))
}
#[cfg(target_os = "linux")]
fn write_owned(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("应用数据路径无效。")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".markwrite-settings-{}-{nonce}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        crate::storage::replace_file(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[cfg(target_os = "linux")]
fn exec_program(value: &str) -> Option<String> {
    // Desktop string unescaping happens before Exec argument unquoting.
    let mut decoded = String::new();
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        decoded.push(if character == '\\' {
            match characters.next()? {
                '\\' => '\\',
                's' => ' ',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                _ => return None,
            }
        } else {
            character
        });
    }
    let mut program = String::new();
    let mut quoted = false;
    let mut characters = decoded.chars();
    while let Some(character) = characters.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' => program.push(characters.next()?),
            '%' => {
                if characters.next()? != '%' {
                    return None;
                }
                program.push('%');
            }
            ' ' | '\t' if !quoted => break,
            _ => program.push(character),
        }
    }
    (!quoted && !program.is_empty()).then_some(program)
}
#[cfg(target_os = "linux")]
fn installed_desktop_id(
    directories: &[std::path::PathBuf],
    search_path: &[std::path::PathBuf],
) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    fn executable(path: &Path) -> bool {
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    for id in [
        "markwrite-app.desktop",
        "Markwrite.desktop",
        "markwrite.desktop",
    ] {
        // The first existing entry shadows entries with the same ID in lower-priority XDG dirs.
        let Some(path) = directories
            .iter()
            .map(|dir| dir.join(id))
            .find(|path| path.is_file())
        else {
            continue;
        };
        if !path.metadata().is_ok_and(|m| m.len() <= 65536) {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let mut main = false;
        let mut values = std::collections::HashMap::new();
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                main = line == "[Desktop Entry]";
            } else if main {
                if let Some((key, value)) = line.split_once('=') {
                    values.insert(key, value);
                }
            }
        }
        if values.get("Type") != Some(&"Application") || values.get("Hidden") == Some(&"true") {
            continue;
        }
        let Some(exec) = values.get("Exec") else {
            continue;
        };
        // Markwrite consumes file paths, not file:// URIs. An entry without %f/%F loses the document.
        if !exec
            .split_whitespace()
            .any(|part| matches!(part, "%F" | "%f"))
        {
            continue;
        }
        let Some(program) = exec_program(exec) else {
            continue;
        };
        let program = Path::new(&program);
        let available = if program.is_absolute() {
            executable(program)
        } else if program.components().count() == 1 {
            search_path.iter().any(|dir| executable(&dir.join(program)))
        } else {
            false
        };
        if available {
            return Some(id.to_string());
        }
    }
    None
}
#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum LinuxMimeBackend {
    Gio,
    Xdg,
}
#[cfg(target_os = "linux")]
impl LinuxMimeBackend {
    fn detect() -> Self {
        let mut command = Command::new("gio");
        command.arg("version");
        if output(command).is_ok() {
            Self::Gio
        } else {
            Self::Xdg
        }
    }
    fn command(self, mime: &str, desktop_id: Option<&str>) -> Command {
        let mut command = match self {
            Self::Gio => {
                let mut command = Command::new("gio");
                command.args(["mime", mime]);
                if let Some(id) = desktop_id {
                    command.arg(id);
                }
                command
            }
            Self::Xdg => {
                let mut command = Command::new("xdg-mime");
                if let Some(id) = desktop_id {
                    command.args(["default", id, mime]);
                } else {
                    command.args(["query", "default", mime]);
                }
                command
            }
        };
        // GIO output is localized by default. Use one fixed locale for this machine-readable call.
        command.env("LC_ALL", "C");
        command
    }
    fn parse_handler(self, text: &str) -> Result<String, String> {
        match self {
            Self::Xdg => Ok(text.trim().to_string()),
            Self::Gio => {
                if let Some(line) = text
                    .lines()
                    .find(|line| line.starts_with("Default application for "))
                {
                    return line
                        .rsplit_once(": ")
                        .map(|(_, id)| id.trim().to_string())
                        .ok_or_else(|| "无法识别系统返回的默认应用。".into());
                }
                if text
                    .lines()
                    .any(|line| line.starts_with("No default applications for "))
                {
                    return Ok(String::new());
                }
                Err("无法识别系统返回的默认应用。".into())
            }
        }
    }
    fn query(self, mime: &str) -> Result<String, String> {
        self.parse_handler(&output(self.command(mime, None))?)
    }
}
#[cfg(target_os = "linux")]
fn linux_status_with(backend: LinuxMimeBackend) -> DefaultStatus {
    let mut handlers = vec![];
    let mut failed = false;
    for mime in ["text/markdown", "text/x-markdown"] {
        // Ubuntu xdg-utils 1.1.3 rejects quoted Exec paths while checking a desktop entry,
        // then reports an unrelated fallback. GIO is also the resolver used by GNOME Files
        // and understands shared-mime-info aliases (text/x-markdown -> text/markdown).
        match backend.query(mime) {
            Ok(application) => handlers.push(MimeHandler {
                r#type: mime.into(),
                application,
            }),
            Err(_) => failed = true,
        }
    }
    let is_default = if failed {
        None
    } else {
        Some(handlers.iter().all(|entry| {
            [
                "markwrite-app.desktop",
                "Markwrite.desktop",
                "markwrite.desktop",
            ]
            .contains(&entry.application.as_str())
        }))
    };
    DefaultStatus {
        platform: "linux".into(),
        is_default,
        handlers,
        can_request: !failed,
        message: if failed {
            "无法查询默认应用。请确认系统已安装 gio 或 xdg-utils 并重试。"
        } else if is_default == Some(true) {
            "Markdown 文件已默认使用 Markwrite 打开。"
        } else {
            "点击按钮后会设置两种 Markdown MIME 类型；不会修改 TXT、HTML 或 DOCX 的默认应用。"
        }
        .into(),
    }
}
#[cfg(target_os = "linux")]
fn linux_status() -> DefaultStatus {
    linux_status_with(LinuxMimeBackend::detect())
}
#[cfg(target_os = "linux")]
fn markdown_default_overrides(text: &str, desktop_id: &str) -> String {
    let mut in_defaults = false;
    let mut result = String::new();
    for line in text.split_inclusive('\n') {
        let value = line.trim().trim_start_matches('\u{feff}');
        if value.starts_with('[') {
            in_defaults = value == "[Default Applications]";
        }
        if in_defaults {
            if let Some((mime, _)) = value.split_once('=') {
                if ["text/markdown", "text/x-markdown"].contains(&mime.trim()) {
                    result.push_str(&format!("{}={desktop_id};", mime.trim()));
                    if line.ends_with("\r\n") {
                        result.push_str("\r\n");
                    } else if line.ends_with('\n') {
                        result.push('\n');
                    }
                    continue;
                }
            }
        }
        result.push_str(line);
    }
    result
}
#[cfg(target_os = "linux")]
fn update_desktop_overrides(
    config: &Path,
    desktops: &str,
    desktop_id: &str,
    backup: &Path,
) -> Result<(), String> {
    // A user's ubuntu-/gnome-mimeapps.list precedes mimeapps.list. GIO and xdg-mime
    // set only the latter, so update existing Markdown overrides in the former too.
    // Never create desktop-specific files or change other associations/sections.
    for desktop in desktops.split(':').filter(|name| !name.is_empty()) {
        if !desktop
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            continue;
        }
        let path = config.join(format!("{}-mimeapps.list", desktop.to_ascii_lowercase()));
        let path = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法读取桌面默认应用配置：{error}")),
        };
        if !fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() <= 1024 * 1024) {
            return Err("桌面默认应用配置不是有效文件或超过 1MB。".into());
        }
        let text =
            fs::read_to_string(&path).map_err(|e| format!("无法读取桌面默认应用配置：{e}"))?;
        let updated = markdown_default_overrides(&text, desktop_id);
        if updated != text {
            // Reuse the conflict-checked atomic writer with a private pre-change backup.
            crate::storage::atomic_write(
                &path,
                updated.as_bytes(),
                Some(&crate::storage::version(text.as_bytes())),
                backup,
            )?;
        }
    }
    Ok(())
}
#[cfg(windows)]
fn registry_command() -> Result<Command, String> {
    let windows = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录。")?;
    Ok(Command::new(
        Path::new(&windows).join("System32").join("reg.exe"),
    ))
}
#[cfg(any(windows, test))]
struct Registration {
    key: String,
    value: Option<String>,
    data: String,
}
#[cfg(any(windows, test))]
fn windows_registration(executable: &str) -> Result<Vec<Registration>, String> {
    if executable.contains('"') || executable.chars().any(char::is_control) {
        return Err("Windows 应用路径无效。".into());
    }
    let command = format!("\"{executable}\" \"%1\"");
    let mut entries = vec![
        Registration {
            key: r"HKCU\Software\Classes\Markwrite.Markdown".into(),
            value: None,
            data: "Markdown document".into(),
        },
        Registration {
            key: r"HKCU\Software\Classes\Markwrite.Markdown\DefaultIcon".into(),
            value: None,
            data: format!("\"{executable}\",0"),
        },
        Registration {
            key: r"HKCU\Software\Classes\Markwrite.Markdown\shell\open\command".into(),
            value: None,
            data: command.clone(),
        },
        Registration {
            key: r"HKCU\Software\Markwrite\Capabilities".into(),
            value: Some("ApplicationName".into()),
            data: "Markwrite".into(),
        },
        Registration {
            key: r"HKCU\Software\Markwrite\Capabilities".into(),
            value: Some("ApplicationDescription".into()),
            data: "Markdown editor".into(),
        },
        Registration {
            key: r"HKCU\Software\RegisteredApplications".into(),
            value: Some("Markwrite".into()),
            data: r"Software\Markwrite\Capabilities".into(),
        },
        Registration {
            key: r"HKCU\Software\Classes\Applications\markwrite.exe\shell\open\command".into(),
            value: None,
            data: command,
        },
    ];
    for extension in [".md", ".markdown"] {
        entries.push(Registration {
            key: r"HKCU\Software\Markwrite\Capabilities\FileAssociations".into(),
            value: Some(extension.into()),
            data: "Markwrite.Markdown".into(),
        });
        entries.push(Registration {
            key: format!(r"HKCU\Software\Classes\{extension}\OpenWithProgids"),
            value: Some("Markwrite.Markdown".into()),
            data: String::new(),
        });
        entries.push(Registration {
            key: r"HKCU\Software\Classes\Applications\markwrite.exe\SupportedTypes".into(),
            value: Some(extension.into()),
            data: String::new(),
        });
    }
    Ok(entries)
}
#[cfg(any(windows, test))]
fn is_markwrite_progid(value: &str) -> bool {
    ["Markwrite.Markdown", r"Applications\markwrite.exe"]
        .iter()
        .any(|known| value.eq_ignore_ascii_case(known))
}
#[cfg(windows)]
fn windows_status() -> DefaultStatus {
    let mut handlers = vec![];
    for extension in [".md", ".markdown"] {
        let application=(|| {
            let mut command=registry_command()?;
            command.args(["query",&format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{extension}\UserChoice"),"/v","ProgId"]);
            let text=output(command).or_else(|_| {
                // An installed app may be the system fallback without a per-user override.
                let mut command=registry_command()?;
                command.args(["query",&format!(r"HKCR\{extension}"),"/ve"]);
                output(command)
            })?;
            Ok::<_,String>(text.lines().find_map(|line| line.split_once("REG_SZ").map(|(_,value)| value.trim().to_string())).unwrap_or_default())
        })().unwrap_or_default();
        handlers.push(MimeHandler {
            r#type: extension.into(),
            application,
        });
    }
    let known = handlers.iter().all(|entry| !entry.application.is_empty());
    let is_default = known.then(|| {
        handlers
            .iter()
            .all(|entry| is_markwrite_progid(&entry.application))
    });
    DefaultStatus {
        platform: "windows".into(),
        is_default,
        handlers,
        can_request: true,
        message: if is_default == Some(true) {
            "Markdown 文件已默认使用 Markwrite 打开。"
        } else {
            "点击按钮会打开 Windows 默认应用设置，请在那里选择 Markwrite；应用不会绕过系统确认。"
        }
        .into(),
    }
}
#[cfg(target_os = "macos")]
fn macos_status() -> DefaultStatus {
    match crate::macos::handlers() {
        Ok(handlers) => {
            let is_default = handlers
                .iter()
                .all(|(_, app)| app == "app.markwrite.desktop");
            DefaultStatus { platform:"macos".into(), is_default:Some(is_default),
                handlers:handlers.into_iter().map(|(r#type,application)| MimeHandler{r#type,application}).collect(),
                can_request:true, message: if is_default { "Markdown 已默认由 Markwrite 打开。 / Markwrite is the default Markdown application." } else { "仅更改 Markdown；若系统要求确认，可在 Finder → 显示简介 → 打开方式 → 全部更改中选择 Markwrite。 / Markdown only; use Finder → Get Info → Open with → Change All if confirmation is required." }.into() }
        }
        Err(message) => DefaultStatus {
            platform: "macos".into(),
            is_default: None,
            handlers: vec![],
            can_request: true,
            message,
        },
    }
}
#[tauri::command]
pub async fn default_markdown_status() -> Result<DefaultStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(macos_status)
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return tauri::async_runtime::spawn_blocking(linux_status)
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(windows_status)
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        Ok(DefaultStatus {
            platform: "other".into(),
            is_default: None,
            handlers: vec![],
            can_request: false,
            message: "请在系统文件管理器的“打开方式”中选择 Markwrite。".into(),
        })
    }
}
#[tauri::command]
pub async fn request_markdown_default(app: tauri::AppHandle) -> Result<DefaultStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(|| {
            crate::macos::set_default()?;
            Ok(macos_status())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let config = app.path().config_dir().map_err(|e| e.to_string())?;
        let applications = app
            .path()
            .data_dir()
            .map_err(|e| e.to_string())?
            .join("applications");
        return tauri::async_runtime::spawn_blocking(move || {
            let mut directories = vec![applications.clone()];
            directories.extend(
                std::env::split_paths(
                    &std::env::var_os("XDG_DATA_DIRS")
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "/usr/local/share:/usr/share".into()),
                )
                .filter(|path| path.is_absolute())
                .map(|path| path.join("applications")),
            );
            let search_path: Vec<_> =
                std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
            let desktop_id = if let Some(id) = installed_desktop_id(&directories, &search_path) {
                id
            } else {
                // AppImage's current_exe is inside a temporary mount; retain its persistent launcher.
                let executable = std::env::var_os("APPIMAGE")
                    .map(std::path::PathBuf::from)
                    .filter(|path| path.is_absolute() && path.is_file())
                    .unwrap_or(executable);
                let icon = data.join("markwrite-icon.png");
                write_owned(&icon, include_bytes!("../icons/128x128.png"))?;
                // Stable user-level name avoids replacing any system package or unrelated desktop file.
                write_owned(
                    &applications.join("markwrite-app.desktop"),
                    desktop_entry(&executable, &icon)?.as_bytes(),
                )?;
                "markwrite-app.desktop".to_string()
            };
            let mut database = Command::new("update-desktop-database");
            database.arg(&applications);
            let _ = output(database);
            let backend = LinuxMimeBackend::detect();
            for mime in ["text/markdown", "text/x-markdown"] {
                output(backend.command(mime, Some(&desktop_id)))?;
            }
            update_desktop_overrides(
                &config,
                &std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
                &desktop_id,
                &data.join("association-backups"),
            )?;
            let mut status = linux_status_with(backend);
            if status.is_default != Some(true) {
                status.message =
                    "系统尚未确认全部 Markdown 关联，请刷新状态或在系统设置中选择 Markwrite。"
                        .into();
            }
            Ok(status)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let _ = app;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let executable = executable.to_str().ok_or("应用路径无法编码。")?.to_string();
        return tauri::async_runtime::spawn_blocking(move || {
            // Register availability only. Never write extension defaults or UserChoice.
            for registration in windows_registration(&executable)? {
                let mut command=registry_command()?;command.arg("add").arg(registration.key);
                if let Some(value)=registration.value { command.arg("/v").arg(value); } else {command.arg("/ve");}
                command.args(["/t","REG_SZ","/d"]).arg(registration.data).arg("/f");output(command)?;
            }
            // The general page works on Windows 10 as well as Windows 11; app-specific query
            // parameters require newer Windows 11 cumulative updates.
            open::that_detached("ms-settings:defaultapps").map_err(|e|format!("无法打开 Windows 设置：{e}"))?;
            let mut status=windows_status();status.message="已打开 Windows 默认应用设置。请为 .md 和 .markdown 选择 Markwrite，返回后点击刷新状态。".into();Ok(status)
        }).await.map_err(|e|e.to_string())?;
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        let _ = app;
        default_markdown_status().await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn gio_output_parsing_accepts_locale_independent_punctuation_and_missing_default() {
        let backend = LinuxMimeBackend::Gio;
        for text in [
            "Default application for ?text/markdown?: markwrite-app.desktop\nRegistered applications:\n\ttypora.desktop",
            "Default application for ‘text/markdown’: markwrite-app.desktop",
        ] {
            assert_eq!(backend.parse_handler(text).unwrap(), "markwrite-app.desktop");
        }
        assert_eq!(
            backend
                .parse_handler("No default applications for ?text/markdown?")
                .unwrap(),
            ""
        );
        assert!(backend.parse_handler("Unexpected system response").is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_override_patch_changes_only_existing_markdown_defaults() {
        let input = "# user preferences\r\n[Default Applications]\r\ntext/markdown=typora.desktop;\r\ntext/plain=other.desktop;\r\ntext/x-markdown=typora.desktop;\r\n\r\n[Added Associations]\r\ntext/markdown=typora.desktop;\r\n";
        let patched = markdown_default_overrides(input, "markwrite-app.desktop");
        assert_eq!(patched, "# user preferences\r\n[Default Applications]\r\ntext/markdown=markwrite-app.desktop;\r\ntext/plain=other.desktop;\r\ntext/x-markdown=markwrite-app.desktop;\r\n\r\n[Added Associations]\r\ntext/markdown=typora.desktop;\r\n");
        assert_eq!(
            markdown_default_overrides(
                "[Added Associations]\ntext/markdown=other.desktop;",
                "markwrite-app.desktop"
            ),
            "[Added Associations]\ntext/markdown=other.desktop;"
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn gio_resolves_quoted_launchers_aliases_and_user_desktop_overrides() {
        use std::os::unix::fs::PermissionsExt;
        // Each child gets isolated XDG directories; this never changes the user's associations.
        if Command::new("gio").arg("version").output().is_err() {
            eprintln!(
                "GIO integration check requires the gio CLI; parser/override unit tests still run."
            );
            return;
        }
        let base = std::env::temp_dir().join(format!(
            "markwrite-gio-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config = base.join("config");
        let data = base.join("data");
        let empty = base.join("empty");
        let bin = base.join("bin with spaces");
        for path in [&config, &data.join("applications"), &empty, &bin] {
            fs::create_dir_all(path).unwrap();
        }
        let program = bin.join("launcher");
        fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        for id in ["markwrite-app.desktop", "other.desktop"] {
            fs::write(
                data.join("applications").join(id),
                desktop_entry(&program, Path::new("/tmp/icon.png")).unwrap(),
            )
            .unwrap();
        }
        let prior = "[Default Applications]\ntext/markdown=other.desktop;\ntext/plain=other.desktop;\n\n[Added Associations]\ntext/markdown=other.desktop;\n";
        for name in ["ubuntu-mimeapps.list", "gnome-mimeapps.list"] {
            fs::write(config.join(name), prior).unwrap();
        }
        let backend = LinuxMimeBackend::Gio;
        let run = |mime: &str, id: Option<&str>| {
            let mut command = backend.command(mime, id);
            command
                .env("XDG_CONFIG_HOME", &config)
                .env("XDG_CONFIG_DIRS", &empty)
                .env("XDG_DATA_HOME", &data)
                .env("XDG_DATA_DIRS", "/usr/share")
                .env("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
            output(command).unwrap()
        };
        assert_eq!(
            backend.parse_handler(&run("text/markdown", None)).unwrap(),
            "other.desktop"
        );
        for mime in ["text/markdown", "text/x-markdown"] {
            run(mime, Some("markwrite-app.desktop"));
        }
        // Reproduce GIO's generic-file update being shadowed by desktop-specific defaults.
        assert_eq!(
            backend.parse_handler(&run("text/markdown", None)).unwrap(),
            "other.desktop"
        );
        let backup = base.join("backups");
        update_desktop_overrides(
            &config,
            "ubuntu:GNOME:../outside",
            "markwrite-app.desktop",
            &backup,
        )
        .unwrap();
        for mime in ["text/markdown", "text/x-markdown"] {
            assert_eq!(
                backend.parse_handler(&run(mime, None)).unwrap(),
                "markwrite-app.desktop"
            );
        }
        for name in ["ubuntu-mimeapps.list", "gnome-mimeapps.list"] {
            let path = config.join(name);
            let versions = crate::history::list(&backup, &path).unwrap();
            assert_eq!(versions.len(), 1);
            assert_eq!(
                crate::history::read(&backup, &path, &versions[0].id)
                    .unwrap()
                    .content,
                prior
            );
            assert!(fs::read_to_string(path)
                .unwrap()
                .contains("text/plain=other.desktop;"));
        }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn desktop_entry_escapes_paths_and_names_app_in_english() {
        let entry = desktop_entry(
            Path::new("/tmp/a b/$demo%/markwrite"),
            Path::new("/tmp/icon.png"),
        )
        .unwrap();
        assert!(entry.contains("Name=Markwrite\n"));
        assert!(entry.contains("\\\\$demo%%"));
        assert!(entry.contains("MimeType=text/markdown;text/x-markdown;"));
        assert!(!entry.contains("墨页"));
        assert!(desktop_entry(
            Path::new("/tmp/injected\nExec=bad"),
            Path::new("/tmp/icon.png")
        )
        .is_err());
    }
    #[test]
    fn windows_registration_never_overrides_user_choice() {
        let entries = windows_registration(r"C:\Program Files\Markwrite\markwrite.exe").unwrap();
        assert!(entries
            .iter()
            .all(|entry| !entry.key.contains("UserChoice")));
        assert!(entries
            .iter()
            .all(|entry| !(entry.key.ends_with(r"Classes\.md")
                || entry.key.ends_with(r"Classes\.markdown"))));
        assert!(entries
            .iter()
            .any(|entry| entry.key.ends_with(r"shell\open\command")
                && entry.data == r#""C:\Program Files\Markwrite\markwrite.exe" "%1""#));
        assert!(entries
            .iter()
            .any(|entry| entry.value.as_deref() == Some(".markdown")));
        assert!(is_markwrite_progid("MARKWRITE.MARKDOWN"));
        assert!(is_markwrite_progid(r"Applications\markwrite.exe"));
        assert!(!is_markwrite_progid("Other.NotMarkwrite"));
        assert!(windows_registration("C:\\invalid\"app.exe").is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_selection_checks_arguments_paths_and_xdg_shadowing() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!(
            "markwrite-desktop-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let user = base.join("user");
        let system = base.join("system");
        let bin = base.join("bin");
        for path in [&user, &system, &bin] {
            fs::create_dir_all(path).unwrap();
        }
        let program = bin.join("markwrite");
        fs::write(&program, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let directories = vec![user.clone(), system.clone()];
        let search = vec![bin];
        // Previously generated DEBs omitted the file placeholder and silently lost the filename.
        fs::write(
            system.join("Markwrite.desktop"),
            "[Desktop Entry]\nType=Application\nExec=markwrite\n",
        )
        .unwrap();
        assert_eq!(installed_desktop_id(&directories, &search), None);
        fs::write(
            system.join("Markwrite.desktop"),
            "[Desktop Entry]\nType=Application\nExec=markwrite %F\n",
        )
        .unwrap();
        assert_eq!(
            installed_desktop_id(&directories, &search).as_deref(),
            Some("Markwrite.desktop")
        );
        fs::write(
            user.join("Markwrite.desktop"),
            "[Desktop Entry]\nHidden=true\n",
        )
        .unwrap();
        assert_eq!(installed_desktop_id(&directories, &search), None);
        fs::write(
            user.join("markwrite-app.desktop"),
            desktop_entry(&program, Path::new("/tmp/icon.png")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            installed_desktop_id(&directories, &search).as_deref(),
            Some("markwrite-app.desktop")
        );
        fs::remove_file(&program).unwrap();
        assert_eq!(installed_desktop_id(&directories, &search), None);
        for path in [
            "/tmp/app with spaces/markwrite",
            "/tmp/$quoted%\\path/markwrite",
        ] {
            assert_eq!(
                exec_program(&desktop_exec(Path::new(path)).unwrap()).as_deref(),
                Some(path)
            );
        }
        fs::remove_dir_all(base).unwrap();
    }
}
