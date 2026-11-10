// Small Win32 helpers the island needs and Tauri doesn't expose.
use std::ffi::c_void;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, FALSE, HLOCAL, HWND, LPARAM, LocalFree, POINT, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
use std::collections::HashMap;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetCursorPos, GetForegroundWindow, GetIconInfo, SetForegroundWindow, ICONINFO,
};

pub fn cursor() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

/// The left mouse button is held: a drag (of a file, say) may be under way.
pub fn mouse_down() -> bool {
    unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x01) as u16 & 0x8000 != 0 }
}

pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

pub fn set_foreground(hwnd: isize) {
    if hwnd != 0 {
        unsafe {
            let _ = SetForegroundWindow(HWND(hwnd as *mut c_void));
        }
    }
}

struct Probe {
    x: i32,
    y: i32,
    own: isize,
    found: bool,
}

unsafe extern "system" fn probe_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let p = &mut *(lparam.0 as *mut Probe);
    if hwnd.0 as isize == p.own || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return TRUE;
    }
    // overlays and tool palettes (NVIDIA, Discord...) aren't app windows
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & (WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) != 0 {
        return TRUE;
    }
    // windows on other virtual desktops are "cloaked" but still visible to the API
    let mut cloaked: u32 = 0;
    let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
    if cloaked != 0 {
        return TRUE;
    }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() || !(p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom) {
        return TRUE;
    }
    let mut cls = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut cls) as usize;
    let cls = String::from_utf16_lossy(&cls[..n]);
    // the topmost window at the point decides: the desktop and taskbar don't count
    p.found = !matches!(cls.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd");
    FALSE // stop: this is the window under the point
}

/// Whether an ordinary app window (active or not) is the top window at the point.
pub fn app_window_at(x: i32, y: i32, own: isize) -> bool {
    let mut p = Probe { x, y, own, found: false };
    unsafe {
        let _ = EnumWindows(Some(probe_window), LPARAM(&mut p as *mut Probe as isize));
    }
    p.found
}

/// Keeps the island out of screen captures, so it can look at what lies under it
/// (and so screenshots show the page, not the island).
pub fn exclude_from_capture(hwnd: isize) {
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(hwnd as *mut c_void), WDA_EXCLUDEFROMCAPTURE);
    }
}

/// Whether a screen area holds something (text, icons, a picture) rather than one
/// flat colour. Pixels are read and dropped right away; nothing is kept.
pub fn area_busy(x: i32, y: i32, w: i32, h: i32) -> bool {
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let _ = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY);
        SelectObject(mem, old);
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        GetDIBits(mem, bmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
    }
    // the most common colour is the background; count pixels clearly off it
    let mut counts: HashMap<u32, u32> = HashMap::new();
    for p in bgra.chunks(4) {
        *counts.entry(u32::from_le_bytes([p[0] & 0xF0, p[1] & 0xF0, p[2] & 0xF0, 0])).or_default() += 1;
    }
    let Some((&bg, _)) = counts.iter().max_by_key(|(_, n)| **n) else { return false };
    let [bb, bgc, br, _] = bg.to_le_bytes();
    let off = bgra.chunks(4).filter(|p| {
        let d = (p[0] as i32 - bb as i32).abs() + (p[1] as i32 - bgc as i32).abs() + (p[2] as i32 - br as i32).abs();
        d > 60
    }).count();
    off * 100 > bgra.len() / 4 // more than 1% of the area
}

/// Changes every time anything is put on the clipboard: a cheap way to poll it.
pub fn clipboard_seq() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(HLOCAL(out.pbData as *mut c_void));
    }
    v
}

/// Encrypts for the current Windows user (DPAPI): copied text can hold passwords.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptProtectData(&blob(data), PCWSTR::null(), None, None, None, 0, &mut out) }.ok()?;
    Some(take(out))
}

pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe { CryptUnprotectData(&blob(data), None, None, None, None, 0, &mut out) }.ok()?;
    Some(take(out))
}

/// The file's own icon as it shows in Explorer, as a 32×32 PNG.
pub fn file_icon_png(path: &str) -> Option<Vec<u8>> {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let mut info = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || info.hIcon.is_invalid() {
        #[cfg(debug_assertions)]
        eprintln!("[icon] SHGetFileInfo failed for {path}: {ok}");
        return None;
    }
    let png = icon_to_png(info);
    #[cfg(debug_assertions)]
    eprintln!("[icon] {path}: {}", png.as_ref().map_or("convert failed".to_string(), |p| format!("{} bytes", p.len())));
    unsafe {
        let _ = DestroyIcon(info.hIcon);
    }
    png
}

fn icon_to_png(info: SHFILEINFOW) -> Option<Vec<u8>> {
    let mut ii = ICONINFO::default();
    if let Err(e) = unsafe { GetIconInfo(info.hIcon, &mut ii) } {
        #[cfg(debug_assertions)]
        eprintln!("[icon] GetIconInfo: {e}");
        let _ = e;
        return None;
    }
    let size = 32i32;
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: size,
        biHeight: -size, // top-down rows
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bgra = vec![0u8; (size * size * 4) as usize];
    let lines = unsafe {
        let dc = GetDC(None);
        let n = GetDIBits(dc, ii.hbmColor, 0, size as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        let _ = DeleteObject(ii.hbmColor);
        let _ = DeleteObject(ii.hbmMask);
        n
    };
    if lines == 0 {
        #[cfg(debug_assertions)]
        eprintln!("[icon] GetDIBits returned 0");
        return None;
    }
    // old icons carry no alpha channel: treat them as opaque
    let has_alpha = bgra.chunks(4).any(|p| p[3] != 0);
    let rgba: Vec<u8> = bgra
        .chunks(4)
        .flat_map(|p| [p[2], p[1], p[0], if has_alpha { p[3] } else { 255 }])
        .collect();
    let img = image::RgbaImage::from_raw(size as u32, size as u32, rgba)?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}
