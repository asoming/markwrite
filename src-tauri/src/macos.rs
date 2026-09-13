//! Launch Services registration, invoked only by the explicit defaults button.
use std::{
    ffi::{c_char, c_void},
    ptr,
};
const UTF8: u32 = 0x08000100;
const ALL_ROLES: u32 = 0xffffffff;
const BUNDLE: &str = "app.markwrite.desktop";
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithBytes(
        allocator: *const c_void,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> *const c_void;
    fn CFStringGetLength(value: *const c_void) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(
        value: *const c_void,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> u8;
    fn CFRelease(value: *const c_void);
}
#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyDefaultRoleHandlerForContentType(content: *const c_void, roles: u32) -> *const c_void;
    fn LSSetDefaultRoleHandlerForContentType(
        content: *const c_void,
        roles: u32,
        bundle: *const c_void,
    ) -> i32;
    fn UTTypeCreatePreferredIdentifierForTag(
        class: *const c_void,
        tag: *const c_void,
        conforming: *const c_void,
    ) -> *const c_void;
}
struct StringRef(*const c_void);
impl Drop for StringRef {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
impl StringRef {
    fn new(text: &str) -> Result<Self, String> {
        let value = unsafe {
            CFStringCreateWithBytes(ptr::null(), text.as_ptr(), text.len() as isize, UTF8, 0)
        };
        if value.is_null() {
            Err("macOS 字符串分配失败 / Cannot allocate macOS string".into())
        } else {
            Ok(Self(value))
        }
    }
    fn text(&self) -> String {
        if self.0.is_null() {
            return String::new();
        }
        unsafe {
            let length = CFStringGetMaximumSizeForEncoding(CFStringGetLength(self.0), UTF8) + 1;
            let mut bytes = vec![0u8; length as usize];
            if CFStringGetCString(self.0, bytes.as_mut_ptr().cast(), length, UTF8) == 0 {
                return String::new();
            }
            let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
            String::from_utf8_lossy(&bytes[..end]).into_owned()
        }
    }
}
fn types() -> Result<Vec<String>, String> {
    let class = StringRef::new("public.filename-extension")?;
    let mut types = vec!["net.daringfireball.markdown".to_string()];
    for extension in ["md", "markdown"] {
        let tag = StringRef::new(extension)?;
        let identifier = StringRef(unsafe {
            UTTypeCreatePreferredIdentifierForTag(class.0, tag.0, ptr::null())
        })
        .text();
        // Never change the handler of a broad class such as plain text.
        if (identifier.starts_with("dyn.") || identifier.to_lowercase().contains("markdown"))
            && !types.contains(&identifier)
        {
            types.push(identifier);
        }
    }
    Ok(types)
}
pub fn handlers() -> Result<Vec<(String, String)>, String> {
    types()?
        .into_iter()
        .map(|kind| {
            let value = StringRef::new(&kind)?;
            let handler =
                StringRef(unsafe { LSCopyDefaultRoleHandlerForContentType(value.0, ALL_ROLES) })
                    .text();
            Ok((kind, handler))
        })
        .collect()
}
pub fn set_default() -> Result<(), String> {
    let bundle = StringRef::new(BUNDLE)?;
    for kind in types()? {
        let value = StringRef::new(&kind)?;
        let status = unsafe { LSSetDefaultRoleHandlerForContentType(value.0, ALL_ROLES, bundle.0) };
        if status != 0 {
            return Err(format!("macOS 未确认默认应用（{status}）；请在 Finder 显示简介 → 打开方式 → 全部更改中选择 Markwrite。 / Choose Markwrite in Finder → Get Info → Open with → Change All."));
        }
    }
    Ok(())
}
