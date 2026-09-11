#!/usr/bin/env bash
set -euo pipefail
markwrite_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -x "$markwrite_dir/bin/markwrite" ]]; then
  printf '%s\n' '尚未找到桌面程序。请先构建，或安装发行版中的 .deb 文件。' >&2
  exit 1
fi
exec "$markwrite_dir/bin/markwrite" "$@"
