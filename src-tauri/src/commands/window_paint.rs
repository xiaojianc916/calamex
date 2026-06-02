//! 拖拽 / 缩放期间「漏底」(trailing-edge bleed-through) 抑制。
//!
//! 背景：WRY 在 Windows 上以「窗口化宿主」(windowed hosting) 承载 WebView2 —— WebView2 是
//! 一个独立子窗口，由 DWM 单独合成。宿主窗口缩放 / 拖拽时，子表面会比窗口边框慢一帧，
//! 尾边因此短暂露出宿主窗口的默认擦除底色（黑 / 白），即俗称的「漏底」。该问题无法在
//! 应用层 100% 根除（根治需切换到 Visual/Composition hosting，未被 Tauri/WRY 暴露），
//! 但可通过对宿主窗口做 Win32 子类化把它压到肉眼几乎不可见：
//!
//! - 方案 A：拦截 `WM_ERASEBKGND`，用当前主题底色填满客户区后返回「已处理」，
//!   保证任何瞬时露出的区域都与内容同色，而非黑 / 白默认擦除色。
//! - 方案 B：在 `WM_EXITSIZEMOVE`（交互式尺寸 / 移动循环结束）强制一次带子窗口的
//!   干净重绘，抹掉缩放结束后的残留撕裂帧。
//!
//! 与现有 `set_window_background`（仅设置窗口画刷，且在 Windows 上 alpha != 0 时不作用于
//! webview 层）互补，且 `WM_ERASEBKGND` 拦截优先级更高。仅浅色模式：底色默认 #fafafa，
//! 并由前端主题通过 `set_resize_paint_color` 同步。

use tauri::{Runtime, WebviewWindow};

/// 将 RGB 转为 Win32 `COLORREF`（0x00BBGGRR）。
#[cfg(any(windows, test))]
const fn colorref_from_rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

/// 更新漏底填充所用的主题底色（RGB）。线程安全，可随主题切换随时调用。
/// 非 Windows 平台为 no-op。
pub fn set_resize_paint_color(r: u8, g: u8, b: u8) {
    #[cfg(windows)]
    imp::store_color(r, g, b);

    #[cfg(not(windows))]
    {
        let _ = (r, g, b);
    }
}

/// 为指定窗口安装拖拽 / 缩放漏底抑制（Win32 子类化）。
/// 非 Windows 平台为 no-op。失败时仅记录日志，绝不 panic。
pub fn install_resize_paint_guard<R: Runtime>(window: &WebviewWindow<R>, color: (u8, u8, u8)) {
    set_resize_paint_color(color.0, color.1, color.2);

    #[cfg(windows)]
    match window.hwnd() {
        Ok(hwnd) => imp::install(hwnd.0 as isize),
        Err(error) => {
            tracing::warn!(
                event = "window.resize_paint_guard.install_failed",
                label = window.label(),
                error = %error,
            );
        }
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        let _ = color;
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicU32, Ordering};

    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateSolidBrush, DeleteObject, FillRect, RedrawWindow, HDC, RDW_ALLCHILDREN,
        RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, WM_ERASEBKGND, WM_EXITSIZEMOVE,
    };

    /// 子类化实例 id：固定值即可，(hwnd, proc, id) 三元组相同会被幂等替换，避免重复安装。
    const SUBCLASS_ID: usize = 0xCA1A_3E5D;

    /// 当前漏底填充色（COLORREF）。默认 #fafafa，避免首帧读到 0（纯黑）。
    static PAINT_COLOR: AtomicU32 = AtomicU32::new(super::colorref_from_rgb(250, 250, 250));

    pub(super) fn store_color(r: u8, g: u8, b: u8) {
        PAINT_COLOR.store(super::colorref_from_rgb(r, g, b), Ordering::Relaxed);
    }

    pub(super) fn install(hwnd_raw: isize) {
        let hwnd = hwnd_raw as HWND;
        // SAFETY: hwnd 来自 Tauri `WebviewWindow::hwnd()`，在主线程 setup 期间有效；
        // SetWindowSubclass 对相同 (hwnd, proc, id) 幂等替换，不会泄漏子类化链。
        unsafe {
            SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        match msg {
            // 方案 A：用主题底色擦除背景，阻止默认黑 / 白擦除露出。
            WM_ERASEBKGND => {
                let hdc = wparam as HDC;
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if GetClientRect(hwnd, &mut rect) != 0 {
                    let brush = CreateSolidBrush(PAINT_COLOR.load(Ordering::Relaxed) as COLORREF);
                    if !brush.is_null() {
                        FillRect(hdc, &rect, brush);
                        DeleteObject(brush as _);
                    }
                }
                // 返回非零表示「背景已擦除」，阻止系统默认擦除。
                1
            }
            // 方案 B：交互式缩放 / 拖拽结束后，强制一次带子窗口的干净重绘，抹掉残留撕裂帧。
            WM_EXITSIZEMOVE => {
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                RedrawWindow(
                    hwnd,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN,
                );
                result
            }
            _ => DefSubclassProc(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::colorref_from_rgb;

    #[test]
    fn colorref_packs_into_bgr_order() {
        // #fafafa -> 0x00FAFAFA
        assert_eq!(colorref_from_rgb(250, 250, 250), 0x00FA_FAFA);
        // 纯红 (R=255) -> 0x000000FF
        assert_eq!(colorref_from_rgb(255, 0, 0), 0x0000_00FF);
        // 纯绿 (G=255) -> 0x0000FF00
        assert_eq!(colorref_from_rgb(0, 255, 0), 0x0000_FF00);
        // 纯蓝 (B=255) -> 0x00FF0000
        assert_eq!(colorref_from_rgb(0, 0, 255), 0x00FF_0000);
    }
}
