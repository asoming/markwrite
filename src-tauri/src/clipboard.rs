//! Explicit paste only. Never poll the clipboard or read it at startup.
use base64::Engine;
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::{fs, io::Read};
const MAX_FILE: usize = 20 * 1024 * 1024;
const MAX_PIXELS: usize = 16 * 1024 * 1024;
#[derive(Serialize)]
pub struct ClipboardImage {
    name: String,
    mime: String,
    data: String,
}
fn payload(name: String, mime: &str, bytes: Vec<u8>) -> Result<ClipboardImage, String> {
    if bytes.len() > MAX_FILE {
        return Err("剪贴板图片超过20MB，请先压缩。".into());
    }
    Ok(ClipboardImage {
        name,
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
fn encode_pixels(
    width: usize,
    height: usize,
    stride: usize,
    channels: usize,
    pixels: &[u8],
) -> Result<ClipboardImage, String> {
    let count = width
        .checked_mul(height)
        .filter(|v| *v > 0 && *v <= MAX_PIXELS)
        .ok_or("剪贴板图片像素过大。")?;
    if ![3, 4].contains(&channels)
        || stride < width * channels
        || pixels.len() < (height - 1) * stride + width * channels
    {
        return Err("剪贴板图片像素格式无效。".into());
    }
    let mut packed = Vec::with_capacity(count * channels);
    for row in 0..height {
        packed.extend_from_slice(&pixels[row * stride..row * stride + width * channels]);
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
        encoder.set_color(if channels == 4 {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&packed)
            .map_err(|e| e.to_string())?;
    }
    payload("pasted-image.png".into(), "image/png", bytes)
}
#[cfg(target_os = "linux")]
enum LinuxImage {
    Pixels(usize, usize, usize, usize, Vec<u8>),
    Uris(Vec<String>),
}
#[cfg(target_os = "linux")]
fn from_uris(uris: Vec<String>) -> Result<Option<ClipboardImage>, String> {
    // A file-manager copy grants access only to the files actually on the clipboard.
    for uri in uris.into_iter().take(100) {
        let Ok(url) = url::Url::parse(&uri) else {
            continue;
        };
        let Ok(path) = url.to_file_path() else {
            continue;
        };
        let Ok(mime) = crate::image_type(&path) else {
            continue;
        };
        let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        return payload(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            mime,
            bytes,
        )
        .map(Some);
    }
    Ok(None)
}
#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<ClipboardImage>, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            clipboard.request_image(move |clipboard, image| {
                if let Some(image) = image {
                    let (w, h) = (image.width() as usize, image.height() as usize);
                    if w.checked_mul(h).is_none_or(|n| n == 0 || n > MAX_PIXELS) {
                        let _ = send.send(Err("剪贴板图片像素过大。".to_string()));
                        return;
                    }
                    let _ = send.send(Ok(LinuxImage::Pixels(
                        w,
                        h,
                        image.rowstride() as usize,
                        image.n_channels() as usize,
                        image.read_pixel_bytes().to_vec(),
                    )));
                } else {
                    clipboard.request_uris(move |_, uris| {
                        let _ = send.send(Ok(LinuxImage::Uris(
                            uris.iter().map(ToString::to_string).collect(),
                        )));
                    });
                }
            });
        })
        .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            match receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "读取剪贴板超时，请重新复制图片后粘贴。".to_string())??
            {
                LinuxImage::Pixels(w, h, stride, channels, pixels) => {
                    encode_pixels(w, h, stride, channels, &pixels).map(Some)
                }
                LinuxImage::Uris(uris) => from_uris(uris),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            match clipboard.get_image() {
                Ok(image) => {
                    encode_pixels(image.width, image.height, image.width * 4, 4, &image.bytes)
                        .map(Some)
                }
                Err(arboard::Error::ContentNotAvailable) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn padded_rgb_rows_encode_as_png_and_invalid_buffers_are_rejected() {
        let image = encode_pixels(1, 2, 4, 3, &[255, 0, 0, 0, 0, 255, 0]).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.data)
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut decoded).unwrap();
        assert_eq!(decoded, [255, 0, 0, 0, 255, 0]);
        assert!(encode_pixels(1, 2, 4, 3, &[0; 6]).is_err());
        assert!(encode_pixels(usize::MAX, 2, 4, 4, &[]).is_err());
    }
}
