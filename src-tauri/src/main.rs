//! 动态 3D 桌面鱼缸 - Tauri 2 主进程
//!
//! 职责：
//! - 创建无边框透明窗口并嵌入桌面壁纸层（Windows WorkerW），默认点击穿透
//! - 托盘菜单（暂停/设置/画质/自启/退出）
//! - 配置持久化与热更新广播
//! - IPC 命令：get_config / set_config / pause / resume / set_monitor / set_quality / quit

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod desktop;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::config::Config;

/// 暂停状态（托盘与 IPC 命令共享）
pub struct PauseState(pub Mutex<bool>);

/// 钩子线程使用的应用句柄（钩子回调无法捕获参数，经全局转交）
pub static CLICK_APP: OnceLock<AppHandle> = OnceLock::new();

/// 全局退出标志：置位后后台线程（重挂监测/嵌入重试）停止工作，防止退出途中重新挂载
pub static EXITING: AtomicBool = AtomicBool::new(false);

/// 交互模式标志：设置面板打开期间窗口被临时脱离壁纸层提升为顶层窗口，
/// 重挂监测（父窗口不再是 WorkerW 属正常）/尺寸守护线程据此暂停工作
pub static INTERACTIVE: AtomicBool = AtomicBool::new(false);

/// 优雅退出：看门狗先行 → 移除托盘图标 → 隐藏并分离窗口（强制重绘壁纸层清除黑屏）
/// → 销毁窗口 → 退出事件循环。
/// 关键：看门狗必须放在所有清理之前——此前放在 win.destroy() 之后，
/// 而 destroy 在主线程事件回调里挂起时看门狗线程根本不会创建，进程就此残留、
/// 屏幕留下无法关闭的黑窗；先置看门狗可保证 1.5 秒内进程必然终结。
pub fn graceful_exit(app: &AppHandle) {
    EXITING.store(true, Ordering::Relaxed);
    INTERACTIVE.store(false, Ordering::Relaxed);
    tracing::info!("收到退出请求，开始优雅退出流程");

    // 看门狗先行：后续任何一步（托盘移除/重绘/窗口销毁/app.exit）挂起都有兜底
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        std::process::exit(0);
    });

    // 1. 先移除托盘图标：任务栏立即消失，也防止退出过程中再次触发菜单事件
    let _ = app.remove_tray_by_id("aquarium-tray");

    // 2. 隐藏窗口 → 分离壁纸层并强制重绘 WorkerW（清除黑屏残留）→ 销毁窗口
    #[cfg(windows)]
    {
        if let Some(win) = app.get_webview_window("aquarium") {
            if let Ok(h) = win.hwnd() {
                desktop::detach_and_cleanup(h.0 as isize);
            }
            // 强制销毁窗口与 WebView2（close 可能被挂起的页面阻塞，destroy 不走关闭流程）
            let _ = win.destroy();
        }
    }

    // 3. 退出事件循环；若挂起则由看门狗兜底强制结束
    app.exit(0);
}

// ---------- IPC 命令（设计说明书 §4.1） ----------

#[tauri::command]
fn get_config(app: AppHandle) -> Config {
    config::load(&app)
}

#[tauri::command]
fn set_config(app: AppHandle, config: Config) -> Result<(), String> {
    config::save_and_broadcast(&app, &config)
}

#[tauri::command]
fn pause(app: AppHandle, state: State<'_, PauseState>) {
    let mut p = state.0.lock().unwrap();
    *p = true;
    let _ = app.emit("pause-resume", serde_json::json!({ "paused": true }));
}

#[tauri::command]
fn resume(app: AppHandle, state: State<'_, PauseState>) {
    let mut p = state.0.lock().unwrap();
    *p = false;
    let _ = app.emit("pause-resume", serde_json::json!({ "paused": false }));
}

#[tauri::command]
fn set_quality(app: AppHandle, quality: String) -> Result<(), String> {
    let mut cfg = config::load(&app);
    cfg.quality = quality;
    config::save_and_broadcast(&app, &cfg)
}

#[tauri::command]
fn set_monitor(monitor_id: String) {
    // MVP 阶段：主显示器全屏嵌入已默认完成；多屏选择留给后续版本
    tracing::info!(monitor = %monitor_id, "set_monitor 调用（预留接口）");
}

/// 前端诊断日志上报（渲染进程 → logs/aquarium.log）
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!("[前端] {message}"),
        "warn" => tracing::warn!("[前端] {message}"),
        _ => tracing::debug!("[前端] {message}"),
    }
}

/// 计算窗口目标覆盖区域（屏幕物理坐标，返回 x/y/w/h）：
/// multi_monitor=true 且存在多屏时为所有显示器的联合矩形（外接大屏自适应），
/// 否则仅主显示器
#[cfg(windows)]
fn desired_layout(app: &AppHandle, multi_monitor: bool) -> Option<(i32, i32, i32, i32)> {
    let win = app.get_webview_window("aquarium")?;
    let monitors = win.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    if multi_monitor && monitors.len() > 1 {
        let min_x = monitors.iter().map(|m| m.position().x).min()?;
        let min_y = monitors.iter().map(|m| m.position().y).min()?;
        let max_x = monitors
            .iter()
            .map(|m| m.position().x + m.size().width as i32)
            .max()?;
        let max_y = monitors
            .iter()
            .map(|m| m.position().y + m.size().height as i32)
            .max()?;
        Some((min_x, min_y, max_x - min_x, max_y - min_y))
    } else {
        let m = win.primary_monitor().ok().flatten()?;
        Some((
            m.position().x,
            m.position().y,
            m.size().width as i32,
            m.size().height as i32,
        ))
    }
}

/// 将窗口对齐到目标覆盖区域（above_icons=true 时置顶，交互模式用）
#[cfg(windows)]
fn apply_layout(app: &AppHandle, multi_monitor: bool, above_icons: bool) {
    if let Some((x, y, w, h)) = desired_layout(app, multi_monitor) {
        if let Some(win) = app.get_webview_window("aquarium") {
            if let Ok(hd) = win.hwnd() {
                desktop::set_window_rect(hd.0 as isize, x, y, w, h, above_icons);
            }
        }
    }
}

/// 开关交互模式：设置面板打开时窗口临时脱离壁纸层提升为顶层（桌面图标层会拦截
/// 全屏鼠标点击，壁纸层之下的窗口仅移除穿透样式永远收不到点击，必须提升到图标层之上），
/// 面板关闭后重新挂回壁纸层并恢复点击穿透。异步命令：重新挂载内部含探测重试，避免阻塞主线程。
#[tauri::command]
async fn set_interactive(app: AppHandle, enabled: bool) {
    INTERACTIVE.store(enabled, Ordering::Relaxed);
    #[cfg(windows)]
    {
        if let Some(win) = app.get_webview_window("aquarium") {
            if let Ok(h) = win.hwnd() {
                let hwnd_raw = h.0 as isize;
                if enabled {
                    desktop::enter_interactive(hwnd_raw);
                    let _ = win.set_focus();
                } else {
                    desktop::exit_interactive(hwnd_raw);
                }
            }
        }
        let multi = config::load(&app).multi_monitor;
        apply_layout(&app, multi, enabled);
        tracing::debug!(enabled, "交互模式切换");
    }
    #[cfg(not(windows))]
    let _ = (app, enabled);
}

#[tauri::command]
fn quit(app: AppHandle) {
    graceful_exit(&app);
}

fn main() {
    // 日志：按天轮转写入 logs/ 目录
    let file_appender = tracing_appender::rolling::daily("logs", "aquarium.log");
    let (writer, _log_guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "debug".into()),
        )
        .with_writer(writer)
        .with_ansi(false)
        .init();

    tracing::info!(
        "动态 3D 桌面鱼缸 v{} 启动（日志级别 debug）",
        env!("CARGO_PKG_VERSION")
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PauseState(Mutex::new(false)))
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            pause,
            resume,
            set_quality,
            set_monitor,
            frontend_log,
            set_interactive,
            quit
        ])
        .setup(|app| {
            // 1. 创建无边框、透明、不抢焦点的鱼缸窗口
            let win = WebviewWindowBuilder::new(app, "aquarium", WebviewUrl::default())
                .title("desktop-aquarium")
                .decorations(false)
                .transparent(true)
                .skip_taskbar(true)
                .resizable(false)
                .focused(false)
                .on_page_load(|_webview, payload| {
                    tracing::debug!(url = %payload.url(), event = ?payload.event(), "WebView 页面加载事件");
                })
                .build()?;

            // 2. 铺满目标显示区域（多屏时为联合矩形；挂载前父窗口为空，按屏幕坐标定位）
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                apply_layout(&handle, config::load(&handle).multi_monitor, false);
            }
            #[cfg(not(windows))]
            if let Ok(Some(mon)) = win.primary_monitor() {
                let _ = win.set_position(mon.position().clone());
                let _ = win.set_size(mon.size().clone());
            }
            let url_str = win
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|_| "<unknown>".into());
            tracing::debug!(url = %url_str, "鱼缸窗口已创建并完成定位");

            // 3. 嵌入桌面壁纸层（Windows）
            #[cfg(windows)]
            if let Ok(h) = win.hwnd() {
                let hwnd_raw = h.0 as isize;
                match desktop::attach_to_desktop(hwnd_raw) {
                    Ok(()) => {
                        tracing::info!("已嵌入桌面壁纸层（WorkerW）");
                        desktop::spawn_remount_watcher(hwnd_raw);
                    }
                    Err(e) => {
                        // 先降级为普通窗口欣赏模式（设计说明书 §3.9），
                        // 同时后台每 10 秒重试嵌入（首次启动时 WorkerW 可能尚未就绪）
                        tracing::error!("桌面嵌入失败，先降级为普通窗口模式：{e}；将持续重试");
                        desktop::spawn_attach_retry(hwnd_raw);
                    }
                }
            }

            // 3.4 全局鼠标钩子：穿透模式下捕获"点击鱼缸区域"转发给前端（点击鱼群散开）
            #[cfg(windows)]
            desktop::spawn_click_hook(app.handle().clone());

            // 3.5 窗口布局守护：每 3 秒与目标显示区域（多屏联合矩形/主屏）对齐，
            // 覆盖启动时定位偏差、分辨率/DPI 缩放变化、外接屏热插拔等"不自适应"场景；
            // 交互模式下窗口被临时提升为顶层，跳过对齐避免与面板操作互相干扰
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if crate::EXITING.load(Ordering::Relaxed)
                        || crate::INTERACTIVE.load(Ordering::Relaxed)
                    {
                        continue;
                    }
                    let multi = config::load(&handle).multi_monitor;
                    if let Some((x, y, w, h)) = desired_layout(&handle, multi) {
                        if let Some(win) = handle.get_webview_window("aquarium") {
                            if let Ok(hd) = win.hwnd() {
                                let hwnd_raw = hd.0 as isize;
                                if desktop::get_window_rect(hwnd_raw)
                                    != Some((x, y, w as u32, h as u32))
                                {
                                    desktop::set_window_rect(hwnd_raw, x, y, w, h, false);
                                    tracing::info!(x, y, w, h, "窗口已与目标显示区域重新对齐");
                                }
                            }
                        }
                    }
                });
            }

            // 4. 应用开机自启配置
            let cfg = config::load(&app.handle());
            if cfg.auto_start {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // 5. 创建托盘
            tray::create_tray(&app.handle())?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("动态 3D 桌面鱼缸运行出错");
}
