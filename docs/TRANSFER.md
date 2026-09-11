# 可选 HTTP 图床与发布接口

这两项能力是通用 HTTP 适配器，需要一个符合以下协议的服务端。它们不是对某个图床、对象存储或博客平台的现成集成；签名请求、OAuth、额外表单参数、厂商专用 SDK 均不在当前协议内。

只有用户在界面明确点击上传或发布时才发起请求。文件打开、编辑、保存、启动或定时任务均不会触发这些接口。API 密钥只保存在当前操作的内存中，不写入设置、会话或日志。界面需先展示目标地址与本次发送范围。

## 共同约定

- 远程端点必须使用 HTTPS。本地调试服务可使用 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`，支持显式端口。
- 端点不能含 URL 用户名、密码或 `#` 片段。查询参数按用户配置原样发送，因此不建议把凭据放在查询参数中。
- API 密钥可留空；非空时以 `Authorization: Bearer <apiKey>` 发送。密钥必须是不含控制字符的字符串，最大 16KB。
- 使用 POST，不自动跟随重定向，不自动重试；连接超时 15 秒、整个请求超时 90 秒。
- 只接受 2xx 状态为成功。超时、连接中断或响应解析失败，不等于服务端未收到内容；请先检查服务端结果，再决定是否重试。
- 响应正文上限 2MiB。默认从 JSON 的 `url` 字段取结果；可配置点分字段，如 `data.url` 或 `data.0.url`。路径最多 16 层、256 字节；每段支持英文字母、数字、下划线及连字符。
- JSON 未返回非空字符串时，尝试读取响应的 `Location` 头。相对地址按配置的端点解析。
- 最终结果必须是无 URL 凭据的 HTTP(S) 地址；拒绝 `javascript:`、`data:`、`file:` 等协议。返回地址不会由原生服务自动打开或抓取。

最简单的成功响应：

```json
{"url":"https://example.com/content/result"}
```

也可返回 `201 Created`、空正文以及 `Location: /content/result`。

## 图片上传

Tauri 命令：`upload_image`。

```ts
invoke<{url: string}>('upload_image', {
  request: {
    endpoint: 'https://example.com/api/upload',
    apiKey: '',
    name: 'image.png',
    bytes: [/* 用户选定图片的字节 */],
    fieldName: 'file',
    responsePath: 'url'
  }
})
```

请求为 `multipart/form-data`，包含一个文件字段。`fieldName` 默认 `file`；可改为服务所需的单个字段名称，支持英文字母、数字、下划线及连字符，最多 128 字节。multipart boundary 由 HTTP 库生成。

上传名会去除目录部分。允许 PNG、JPEG、GIF、WebP、AVIF 文件名，并根据扩展名设置 MIME 类型；不支持 SVG。文件非空且不超过 20MiB。服务端仍须按自己的规则验证内容、大小与访问权限。原图片及原 Markdown 文件均不会被该原生命令修改；界面可在上传成功后让用户选择插入返回链接。

## HTML 发布

Tauri 命令：`publish_html`。

```ts
invoke<{url: string}>('publish_html', {
  request: {
    endpoint: 'https://example.com/api/pages',
    apiKey: '',
    name: '报告.html',
    html: '<!doctype html><html>...</html>',
    responsePath: 'url'
  }
})
```

请求正文直接为 HTML，不是 multipart 或 JSON：

```http
Content-Type: text/html; charset=utf-8
X-Markwrite-Filename: <UTF-8 百分号编码后的文件名>
```

服务端可对 `X-Markwrite-Filename` 做百分号解码取得建议名称；该头只提供建议，不指定服务端文件路径。HTML 非空且不超过 32MiB。发布应使用界面已经准备好的当前文档 HTML；用户应检查预览、目标地址和包含的本地图片等内容，再明确确认发送。此命令不保存或覆盖本地源文件，也不代替服务端的鉴权、内容净化和访问控制。

## 验证范围

原生单元测试检查端点策略、点分字段提取、数组索引、Location 回退及危险 URL／头部字符拒绝；测试不会访问互联网、上传图片或发布内容。对真实服务的调用需用户自行配置并明确发起，不能因代码构建成功而宣称已验证某个服务兼容性。

## 本机协议联调示例

下面的 Python 标准库示例只监听本机地址。它用于验证请求类型、大小与 URL 响应提取，不存储、公开或托管收到的文件；返回的 `/result` 是状态页，不是真实图片或文档地址，因此不要把它插入正式文档。请仅选用测试内容，API 密钥留空。

把代码另存为临时目录中的 `mock_transfer.py`：

```python
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_type = self.headers.get("Content-Type", "")
        valid_type = (
            self.path == "/upload" and content_type.startswith("multipart/form-data;")
        ) or (
            self.path == "/publish" and content_type.startswith("text/html")
        )
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not valid_type or not 0 < size <= 33 * 1024 * 1024:
            self.send_error(400, "Unexpected type or length")
            return
        remaining = size
        while remaining:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                self.send_error(400, "Incomplete request")
                return
            remaining -= len(chunk)
        body = json.dumps({"data": {"url": "/result"}}).encode()
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        body = b"Local protocol check only; no content was stored."
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass  # Do not log request headers, credentials, or document content.

HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
```

在该临时目录执行 `python3 mock_transfer.py`；Windows 可使用 `py mock_transfer.py`。随后在墨页填入：

| 项目 | 图片上传 | HTML 发布 |
| --- | --- | --- |
| 服务地址 | `http://127.0.0.1:8765/upload` | `http://127.0.0.1:8765/publish` |
| API 密钥 | 留空 | 留空 |
| 响应字段 | `data.url` | `data.url` |
| 图片表单字段 | `file` | 不适用 |

选择无敏感信息的测试图片或文档，阅读界面显示的发送范围后点击操作。预期结果是 `http://127.0.0.1:8765/result`。使用 `Ctrl+C` 停止示例服务。此示例没有鉴权、持久化与部署配置，只适合本机协议联调，不应开放到公网。
