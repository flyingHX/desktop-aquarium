//! 桌面集成：Windows WorkerW 壁纸层嵌入、点击穿透、Explorer 重启重挂
//!
//! Windows 流程（设计说明书 §7.1）：
//! 1. FindWindow("Progman") → SendMessageTimeout(0x052C) 让其生成承载壁纸的 WorkerW
//! 2. 定位桌面图标层 SHELLDLL_DefView（它是子窗口，宿主可能是 Progman 或某个顶层 WorkerW）
//! 3. 壁纸 WorkerW = 图标层宿主之后的下一个顶层 WorkerW（兼容两种窗口拓扑）
//! 4. SetParent(鱼缸 HWND, WorkerW)
//! 5. 扩展样式 WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE（透明 + 穿透 + 不抢焦点）
//! 6. SetWindowPos(HWND_BOTTOM) 保证位于图标层之下
//! 7. 后台线程每 5 秒检查父窗口是否仍为 WorkerW，Explorer 重启后自动重挂
//!
//! 对外 API 使用 isize 原始句柄，避免与 tauri 内部 windows-rs 版本耦合。

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use windows::Win32::Foundation::{BOOL, COLORREF, HWND, HMODULE, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    RedrawWindow, HRGN, RDW_ALLCHILDREN, RDW_ERASE, RDW_INVALIDATE, RDW_UPDATENOW,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW,
    GetMessageW, GetWindowLongPtrW, GetWindowRect, IsWindow, SendMessageTimeoutW,
    SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowPos, SetWindowsHookExW,
    ShowWindow, GA_PARENT, GWL_EXSTYLE, HHOOK, HWND_BOTTOM, HWND_TOPMOST, LWA_ALPHA,
    MSG, MSLLHOOKSTRUCT, SMTO_NORMAL, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOREDRAW, SWP_NOSIZE,
    SW_HIDE, WH_MOUSE_LL, WM_LBUTTONDOWN, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

#[cfg(windows)]
const PROGMAN_SPAWN_WORKERW: u32 = 0x052C;

/// 鱼缸窗口当前覆盖矩形（屏幕物理坐标 x/y/w/h）。
/// 供全局鼠标钩子判断"点击是否落在鱼缸区域内"——挂载 WorkerW 后窗口是子窗口，
/// GetWindowRect 坐标基准不可靠，因此由 set_window_rect 在每次布局时写入维护。
#[cfg(windows)]
pub static WINDOW_RECT: std::sync::Mutex<Option<(i32, i32, u32, u32)>> =
    std::sync::Mutex::new(None);

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn hwnd_from_raw(raw: isize) -> HWND {
    HWND(raw as *mut core::ffi::c_void)
}

/// 判断窗口类名是否等于指定名称
#[cfg(windows)]
fn class_name_is(hwnd: HWND, name: &str) -> bool {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    let target = to_wide(name);
    n > 0 && n == target.len() - 1 && buf[..n] == target[..n]
}

/// 发送 0x052C 让 Progman 生成承载壁纸的 WorkerW
#[cfg(windows)]
fn spawn_workerw() -> bool {
    unsafe {
        let cls = to_wide("Progman");
        if let Ok(progman) = FindWindowW(PCWSTR(cls.as_ptr()), None) {
            let _ = SendMessageTimeoutW(
                progman,
                PROGMAN_SPAWN_WORKERW,
                WPARAM(0),
                LPARAM(0),
                SMTO_NORMAL,
                1000,
                None,
            );
            tracing::debug!("已找到 Progman 并发送 0x052C");
            return true;
        }
    }
    false
}

/// 判断窗口是否有指定类名的直接子窗口
#[cfg(windows)]
fn window_has_child(hwnd: HWND, child_class: &str) -> bool {
    let cls = to_wide(child_class);
    unsafe {
        FindWindowExW(hwnd, HWND::default(), PCWSTR(cls.as_ptr()), None)
            .map(|w| !w.0.is_null())
            .unwrap_or(false)
    }
}

/// 在顶层窗口 Z 序中，查找 anchor 之后第一个指定类名的顶层窗口
#[cfg(windows)]
fn top_level_after(anchor: HWND, class: &str) -> Option<HWND> {
    let cls = to_wide(class);
    unsafe {
        FindWindowExW(HWND::default(), anchor, PCWSTR(cls.as_ptr()), None)
            .ok()
            .filter(|w| !w.0.is_null())
    }
}

/// EnumWindows 回调：查找承载 SHELLDLL_DefView 的顶层 WorkerW（拓扑 B 的宿主）
#[cfg(windows)]
unsafe extern "system" fn find_workerw_host_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Option<HWND>);
    if class_name_is(hwnd, "WorkerW") && window_has_child(hwnd, "SHELLDLL_DefView") {
        *out = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

/// 查找承载图标层的顶层 WorkerW（拓扑 B 宿主）
#[cfg(windows)]
fn find_workerw_host() -> Option<HWND> {
    let mut out: Option<HWND> = None;
    unsafe {
        let _ = EnumWindows(Some(find_workerw_host_proc), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// 查找承载壁纸的 WorkerW（兼容两种窗口拓扑，0x052C 后最多重试约 5 秒）：
/// - 拓扑 A（最常见）：图标层仍由 Progman 直接承载，壁纸 WorkerW 是 Progman 之后的顶层兄弟窗口；
/// - 拓扑 B：图标层被移入某个顶层 WorkerW，壁纸 WorkerW 是该 WorkerW 之后的下一个顶层兄弟。
#[cfg(windows)]
fn find_wallpaper_workerw() -> Option<HWND> {
    if !spawn_workerw() {
        tracing::warn!("未找到 Progman 窗口，无法触发 WorkerW 生成");
        return None;
    }
    for attempt in 0..10u32 {
        unsafe {
            let cls_progman = to_wide("Progman");
            if let Ok(progman) = FindWindowW(PCWSTR(cls_progman.as_ptr()), None) {
                if !progman.0.is_null() && window_has_child(progman, "SHELLDLL_DefView") {
                    if let Some(w) = top_level_after(progman, "WorkerW") {
                        tracing::info!("已定位 Progman 之后的壁纸 WorkerW（第 {} 次探测）", attempt + 1);
                        return Some(w);
                    }
                }
            }
        }
        if let Some(host) = find_workerw_host() {
            if let Some(w) = top_level_after(host, "WorkerW") {
                tracing::info!("已定位图标 WorkerW 之后的壁纸 WorkerW（第 {} 次探测）", attempt + 1);
                return Some(w);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    log_workerw_diagnostics();
    // 保底方案：0x052C 未能生成 WorkerW 时（部分系统/壁纸模式会出现），直接挂载到
    // Progman —— 图标层是 Progman 的子窗口且 Z 序靠上，挂载后仍在图标之下、壁纸之上。
    unsafe {
        let cls_progman = to_wide("Progman");
        if let Ok(progman) = FindWindowW(PCWSTR(cls_progman.as_ptr()), None) {
            if !progman.0.is_null() && window_has_child(progman, "SHELLDLL_DefView") {
                tracing::warn!("未生成 WorkerW，降级为直接挂载 Progman（效果一致：图标之下）");
                return Some(progman);
            }
        }
    }
    tracing::warn!("已发送 0x052C，仍未定位到壁纸 WorkerW");
    None
}

/// 诊断日志：枚举顶层 WorkerW 与图标层宿主情况，便于用户反馈排查
#[cfg(windows)]
unsafe extern "system" fn count_workerw_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut (u32, bool));
    if class_name_is(hwnd, "WorkerW") {
        out.0 += 1;
        if window_has_child(hwnd, "SHELLDLL_DefView") {
            out.1 = true;
        }
    }
    BOOL(1)
}

/// 输出 WorkerW 拓扑诊断信息
#[cfg(windows)]
fn log_workerw_diagnostics() {
    let mut info = (0u32, false);
    unsafe {
        let _ = EnumWindows(Some(count_workerw_proc), LPARAM(&mut info as *mut _ as isize));
    }
    let progman_hosts_defview = unsafe {
        let cls = to_wide("Progman");
        FindWindowW(PCWSTR(cls.as_ptr()), None)
            .map(|p| !p.0.is_null() && window_has_child(p, "SHELLDLL_DefView"))
            .unwrap_or(false)
    };
    tracing::warn!(
        "诊断：顶层 WorkerW 数量={}，其中承载图标层={}，Progman 承载图标层={}",
        info.0,
        info.1,
        progman_hosts_defview
    );
}

/// 将窗口挂载到桌面壁纸层，并设置点击穿透 / 不抢焦点 / 置底
pub fn attach_to_desktop(hwnd_raw: isize) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = hwnd_from_raw(hwnd_raw);
        let worker = find_wallpaper_workerw().ok_or("未找到 WorkerW 壁纸层（桌面嵌入失败）")?;
        unsafe {
            SetParent(hwnd, worker).map_err(|e| format!("SetParent 失败：{e}"))?;

            // 扩展样式：分层透明 + 鼠标穿透 + 不激活
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                (ex | WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) as isize,
            );

            // 分层窗口必须显式调用 SetLayeredWindowAttributes 才会绘制内容，
            // 否则窗口本体与 WebView2 子窗口可能整块不渲染
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            tracing::debug!(worker = ?worker, "SetParent 完成，已设置分层属性（alpha=255）");

            // 置底：位于图标层之下
            let _ = SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOREDRAW,
            );
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = hwnd_raw;
        Err("桌面嵌入当前仅实现 Windows 平台；macOS/Linux 请参考 README".into())
    }
}

/// 动态开关点击穿透（interactiveMode 旧接口，保留兼容）
#[allow(dead_code)]
pub fn set_click_through(hwnd_raw: isize, enabled: bool) {
    #[cfg(windows)]
    {
        let hwnd = hwnd_from_raw(hwnd_raw);
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let new_ex = if enabled {
                ex | WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0 | WS_EX_NOACTIVATE.0
            } else {
                (ex & !(WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0)) | WS_EX_LAYERED.0
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex as isize);
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd_raw, enabled);
    }
}

/// 进入交互模式：脱离壁纸层、临时提升为顶层窗口。
/// 根因：壁纸 WorkerW 位于桌面图标层（SHELLDLL_DefView/Progman）之下，图标列表
/// 覆盖全屏并拦截所有鼠标点击——壁纸层窗口即使去掉穿透样式也收不到任何点击。
/// 只有临时变回顶层窗口（图标层之上）才能让设置面板真正可交互。
#[allow(dead_code)]
pub fn enter_interactive(hwnd_raw: isize) {
    #[cfg(windows)]
    unsafe {
        let hwnd = hwnd_from_raw(hwnd_raw);
        if !IsWindow(hwnd).as_bool() {
            return;
        }
        // 解除与 WorkerW 的父子关系，恢复为顶层窗口
        let _ = SetParent(hwnd, HWND::default());
        // 取消穿透与不激活样式
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ((ex & !(WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0)) | WS_EX_LAYERED.0) as isize,
        );
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        // 置顶显示（临时，面板关闭后重新挂回壁纸层）
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        tracing::debug!("已进入交互模式（窗口临时提升为顶层）");
    }
    #[cfg(not(windows))]
    let _ = hwnd_raw;
}

/// 退出交互模式：重新挂回壁纸层并恢复穿透样式（布局由调用方重新对齐）
#[allow(dead_code)]
pub fn exit_interactive(hwnd_raw: isize) {
    #[cfg(windows)]
    {
        let _ = attach_to_desktop(hwnd_raw);
    }
    #[cfg(not(windows))]
    let _ = hwnd_raw;
}

/// 设置窗口覆盖区域（x/y/w/h 为屏幕物理坐标）。
/// 挂载于 WorkerW 时坐标相对父窗口原点，需换算；顶层（交互模式）直接用屏幕坐标。
/// above_icons=true 置顶（交互模式），false 置底（图标层之下）。
#[allow(dead_code)]
pub fn set_window_rect(hwnd_raw: isize, x: i32, y: i32, w: i32, h: i32, above_icons: bool) {
    #[cfg(windows)]
    unsafe {
        // 维护钩子用的覆盖矩形（屏幕坐标，与传入目标一致——子窗口坐标换算的目的就是屏幕对齐）
        if let Ok(mut g) = WINDOW_RECT.lock() {
            *g = Some((x, y, w.max(0) as u32, h.max(0) as u32));
        }
        let hwnd = hwnd_from_raw(hwnd_raw);
        if !IsWindow(hwnd).as_bool() {
            return;
        }
        // 子窗口坐标相对父窗口客户区原点；顶层窗口（父为空）即屏幕坐标
        let parent = GetAncestor(hwnd, GA_PARENT);
        let mut off = (0i32, 0i32);
        if !parent.0.is_null() {
            let mut pr = RECT::default();
            if GetWindowRect(parent, &mut pr).is_ok() {
                off = (pr.left, pr.top);
            }
        }
        let z = if above_icons { HWND_TOPMOST } else { HWND_BOTTOM };
        let _ = SetWindowPos(
            hwnd,
            z,
            x - off.0,
            y - off.1,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOREDRAW,
        );
    }
    #[cfg(not(windows))]
    let _ = (hwnd_raw, x, y, w, h, above_icons);
}

/// 读取窗口当前矩形（屏幕物理坐标 x/y/w/h），供布局守护比对
#[allow(dead_code)]
pub fn get_window_rect(hwnd_raw: isize) -> Option<(i32, i32, u32, u32)> {
    #[cfg(windows)]
    unsafe {
        let hwnd = hwnd_from_raw(hwnd_raw);
        if !IsWindow(hwnd).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_ok() {
            return Some((
                r.left,
                r.top,
                (r.right - r.left).max(0) as u32,
                (r.bottom - r.top).max(0) as u32,
            ));
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd_raw;
        None
    }
}

/// 退出清理：隐藏窗口 → 分离出壁纸层 → 对壁纸层（WorkerW/Progman）强制同步重绘，
/// 确保窗口消失后壁纸立即补上（WorkerW 自身默认黑色背景，不对它重绘就会留下黑屏）。
/// 对整个桌面（HWND null）重绘覆盖不到 WorkerW 内部，必须以记录到的父窗口为重绘目标。
pub fn detach_and_cleanup(hwnd_raw: isize) {
    #[cfg(windows)]
    unsafe {
        let hwnd = hwnd_from_raw(hwnd_raw);
        if !IsWindow(hwnd).as_bool() {
            return;
        }
        // 先记录当前父窗口（WorkerW/Progman），分离后以其为重绘目标
        let parent = GetAncestor(hwnd, GA_PARENT);
        ShowWindow(hwnd, SW_HIDE);
        let _ = SetParent(hwnd, HWND::default());
        let repaint_target = if parent.0.is_null() { HWND::default() } else { parent };
        let _ = RedrawWindow(
            repaint_target,
            None,
            HRGN::default(),
            RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW,
        );
        tracing::debug!("已分离窗口并强制重绘壁纸层");
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd_raw;
    }
}

/// 全局低级鼠标钩子回调：左键按下且落在鱼缸覆盖区域内时，把点击位置（相对覆盖
/// 矩形的归一坐标）转发给前端触发"鱼群惊吓散开"。消息照常传递（不吞），
/// 桌面图标功能不受影响；交互模式（设置面板打开）下前端直接收到真实点击，此处跳过。
/// 回调内仅做矩形比较与小载荷 emit，保证低级钩子不超时。
#[cfg(windows)]
unsafe extern "system" fn ll_mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0
        && wparam.0 as u32 == WM_LBUTTONDOWN
        && !crate::INTERACTIVE.load(std::sync::atomic::Ordering::Relaxed)
        && !crate::EXITING.load(std::sync::atomic::Ordering::Relaxed)
    {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // 忽略注入的合成事件（LLMHF_INJECTED = 0x1），只响应用户真实点击
        if ms.flags & 0x1 == 0 {
            let rect = WINDOW_RECT.lock().ok().and_then(|g| *g);
            if let Some((x, y, w, h)) = rect {
                let (mx, my) = (ms.pt.x, ms.pt.y);
                if w > 0 && h > 0 && mx >= x && mx < x + w as i32 && my >= y && my < y + h as i32 {
                    if let Some(app) = crate::CLICK_APP.get() {
                        let _ = app.emit(
                            "canvas-click",
                            serde_json::json!({
                                "u": (mx - x) as f32 / w as f32,
                                "v": (my - y) as f32 / h as f32,
                            }),
                        );
                    }
                }
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// 安装全局低级鼠标钩子（独立线程 + 消息循环）：穿透模式下窗口收不到系统点击，
/// 该钩子是"点击鱼群散开"唯一通路。进程退出时钩子随进程自动解除。
#[allow(dead_code)]
pub fn spawn_click_hook(app: tauri::AppHandle) {
    #[cfg(windows)]
    {
        let _ = crate::CLICK_APP.set(app);
        std::thread::spawn(move || unsafe {
            match SetWindowsHookExW(WH_MOUSE_LL, Some(ll_mouse_proc), HMODULE::default(), 0) {
                Ok(hook) if !hook.is_invalid() => {
                    tracing::debug!("全局鼠标钩子已安装（点击鱼群惊吓散开）");
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {}
                    let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
                }
                _ => tracing::warn!("全局鼠标钩子安装失败，点击散开功能不可用"),
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// 后台监测线程：父窗口不再是 WorkerW（Explorer 重启）时自动重挂
#[allow(dead_code)]
pub fn spawn_remount_watcher(hwnd_raw: isize) {
    #[cfg(windows)]
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if crate::EXITING.load(std::sync::atomic::Ordering::Relaxed) {
            break; // 正在退出，停止重挂
        }
        if crate::INTERACTIVE.load(std::sync::atomic::Ordering::Relaxed) {
            continue; // 交互模式下窗口临时为顶层，父窗口非 WorkerW 属正常现象
        }
        unsafe {
            let hwnd = hwnd_from_raw(hwnd_raw);
            if !IsWindow(hwnd).as_bool() {
                break; // 窗口已销毁，退出监测线程
            }
            let parent = GetAncestor(hwnd, GA_PARENT);
            let parent_ok =
                class_name_is(parent, "WorkerW") || class_name_is(parent, "Progman");
            if !parent_ok {
                tracing::warn!("检测到 WorkerW 失效（可能 Explorer 已重启），正在重新挂载…");
                let _ = attach_to_desktop(hwnd_raw);
            }
        }
    });
}

/// 嵌入失败后的后台重试线程：每 10 秒重试，成功后转入常规失效监测
#[allow(dead_code)]
pub fn spawn_attach_retry(hwnd_raw: isize) {
    #[cfg(windows)]
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(10));
        if crate::EXITING.load(std::sync::atomic::Ordering::Relaxed) {
            break; // 正在退出，停止重试挂载
        }
        if crate::INTERACTIVE.load(std::sync::atomic::Ordering::Relaxed) {
            continue; // 交互模式下不重试挂载，避免把顶层窗口抢回壁纸层
        }
        match attach_to_desktop(hwnd_raw) {
            Ok(()) => {
                tracing::info!("桌面壁纸层重试挂载成功");
                spawn_remount_watcher(hwnd_raw);
                break;
            }
            Err(e) => tracing::warn!("桌面嵌入重试失败：{e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_wide() {
        let w = to_wide("Progman");
        assert_eq!(w.last(), Some(&0));
        assert_eq!(w.len(), 8);
    }
}
