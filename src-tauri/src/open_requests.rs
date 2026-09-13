use std::{path::PathBuf, sync::Mutex};
#[derive(Default)]
pub struct OpenRequests(Mutex<Vec<PathBuf>>);
impl OpenRequests {
    pub fn push(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
    }
    pub fn take(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}
pub fn file_urls(urls: Vec<url::Url>) -> Vec<PathBuf> {
    urls.into_iter()
        .filter(|u| {
            u.scheme() == "file"
                && u.host_str()
                    .is_none_or(|h| h.is_empty() || h == "localhost")
        })
        .filter_map(|u| u.to_file_path().ok())
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_and_repeated_launch_events_are_drained_once() {
        let queue = OpenRequests::default();
        let p = PathBuf::from("/tmp/中文 notes.md");
        queue.push([p.clone(), p.clone()]);
        assert_eq!(queue.take(), vec![p.clone()]);
        assert!(queue.take().is_empty());
        queue.push([p.clone()]);
        assert_eq!(queue.take(), vec![p]);
    }
    #[test]
    fn finder_urls_preserve_unicode_spaces_and_ignore_web_addresses() {
        let p = std::env::temp_dir().join("中文 notes #1.md");
        let urls = vec![
            url::Url::from_file_path(&p).unwrap(),
            url::Url::parse("https://example.com/file.md").unwrap(),
            url::Url::parse("file://remote/share/note.md").unwrap(),
        ];
        assert_eq!(file_urls(urls), vec![p]);
    }
}
