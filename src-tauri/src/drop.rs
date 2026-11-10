// Files dropped on the island. Tauri's own drop handler never sees them here:
// WebView2 draws the page in a child window of its browser process, and OLE
// finds no drop target there. So WebView2 takes the drop itself, the page hands
// the File objects back with postMessageWithAdditionalObjects, and their paths
// are read here.
use tauri::{AppHandle, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::WebMessageReceivedEventHandler;
use windows62::core::{Interface, PWSTR};
use windows62::Win32::System::Com::CoTaskMemFree;

fn paths_of(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else { return out };
    let Ok(objects) = (unsafe { args2.AdditionalObjects() }) else { return out };
    let mut count = 0u32;
    if unsafe { objects.Count(&mut count) }.is_err() {
        return out;
    }
    for i in 0..count {
        let Ok(obj) = (unsafe { objects.GetValueAtIndex(i) }) else { continue };
        let Ok(file) = obj.cast::<ICoreWebView2File>() else { continue };
        let mut p = PWSTR::null();
        if unsafe { file.Path(&mut p) }.is_ok() && !p.is_null() {
            if let Ok(s) = unsafe { p.to_string() } {
                out.push(s);
            }
            unsafe { CoTaskMemFree(Some(p.0 as _)) };
        }
    }
    out
}

pub fn install(w: &WebviewWindow, app: AppHandle) {
    let _ = w.with_webview(move |wv| {
        let Ok(core) = (unsafe { wv.controller().CoreWebView2() }) else { return };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_: Option<ICoreWebView2>, args| {
            if let Some(args) = args {
                let paths = paths_of(&args);
                #[cfg(debug_assertions)]
                eprintln!("[drop] {paths:?}");
                if !paths.is_empty() {
                    crate::add_to_shelf(&app, &paths);
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
    });
}
