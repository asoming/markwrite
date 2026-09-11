#!/usr/bin/env bash
set -euo pipefail
markwrite_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
markwrite_apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
markwrite_desktop="$(xdg-user-dir DESKTOP)"
[[ -x "$markwrite_dir/bin/markwrite" ]] || { printf '%s\n' '请先准备 bin/markwrite 可执行程序。' >&2; exit 1; }
mkdir -p "$markwrite_apps" "$markwrite_desktop"
markwrite_entry="$markwrite_apps/markwrite-app.desktop"
cat > "$markwrite_entry" <<ENTRY
[Desktop Entry]
Version=1.0
Type=Application
Name=Markwrite
Comment=本地优先的 Markdown 编辑器
Exec="$markwrite_dir/scripts/launch.sh" %F
Icon=$markwrite_dir/public/assets/app-icon.png
Terminal=false
Categories=Office;Utility;TextEditor;
MimeType=text/markdown;text/x-markdown;
StartupNotify=true
StartupWMClass=markwrite
ENTRY
chmod +x "$markwrite_entry"
cp "$markwrite_entry" "$markwrite_desktop/Markwrite-App.desktop"
chmod +x "$markwrite_desktop/Markwrite-App.desktop"
if command -v gio >/dev/null 2>&1; then gio set "$markwrite_desktop/Markwrite-App.desktop" metadata::trusted true 2>/dev/null || true; fi
printf '已创建应用菜单入口和桌面图标：%s\n' "$markwrite_desktop/Markwrite-App.desktop"
