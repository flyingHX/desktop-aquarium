//! 托盘服务：暂停/继续、画质切换、开机自启、设置、退出
//!
//! 菜单事件通过全局事件（pause-resume / config-updated / open-settings）
//! 通知渲染窗口，与前端 src/main.ts 中的 ipcListen 一一对应。

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::config;
use crate::PauseState;

/// 托盘菜单项句柄（用于动态更新文本与勾选状态）
pub struct TrayHandles {
    pub pause_item: MenuItem<Wry>,
    pub q_high: CheckMenuItem<Wry>,
    pub q_medium: CheckMenuItem<Wry>,
    pub q_low: CheckMenuItem<Wry>,
    pub autostart: CheckMenuItem<Wry>,
}

/// 创建系统托盘
pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let pause_item = MenuItem::with_id(app, "pause", "暂停", true, None::<&str>)?;
    let q_high = CheckMenuItem::with_id(app, "q_high", "画质 · 高", true, true, None::<&str>)?;
    let q_medium = CheckMenuItem::with_id(app, "q_medium", "画质 · 中", true, false, None::<&str>)?;
    let q_low = CheckMenuItem::with_id(app, "q_low", "画质 · 省电", true, false, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机自启", true, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &pause_item,
            &settings,
            &q_high,
            &q_medium,
            &q_low,
            &autostart,
            &quit,
        ],
    )?;

    let icon = tauri::include_image!("icons/32x32.png");

    TrayIconBuilder::with_id("aquarium-tray")
        .icon(icon)
        .tooltip("动态 3D 桌面鱼缸")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;

    tracing::info!("系统托盘已创建：退出请右键任务栏右下角托盘图标（可能折叠在 ^ 隐藏图标内）→ 退出");

    app.manage(TrayHandles {
        pause_item,
        q_high,
        q_medium,
        q_low,
        autostart,
    });
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "pause" => {
            let paused = {
                let state = app.state::<PauseState>();
                let mut st = state.0.lock().unwrap();
                *st = !*st;
                *st
            };
            let _ = app.emit("pause-resume", serde_json::json!({ "paused": paused }));
            if let Some(h) = app.try_state::<TrayHandles>() {
                let _ = h.pause_item.set_text(if paused { "继续" } else { "暂停" });
            }
        }
        "settings" => {
            let _ = app.emit("open-settings", serde_json::json!({}));
        }
        "q_high" | "q_medium" | "q_low" => {
            let quality = match id {
                "q_high" => "high",
                "q_medium" => "medium",
                _ => "low",
            };
            let mut cfg = config::load(app);
            cfg.quality = quality.to_string();
            let _ = config::save_and_broadcast(app, &cfg);
            if let Some(h) = app.try_state::<TrayHandles>() {
                let _ = h.q_high.set_checked(quality == "high");
                let _ = h.q_medium.set_checked(quality == "medium");
                let _ = h.q_low.set_checked(quality == "low");
            }
        }
        "autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let autolaunch = app.autolaunch();
            let enabled = autolaunch.is_enabled().unwrap_or(false);
            let result = if enabled {
                autolaunch.disable()
            } else {
                autolaunch.enable()
            };
            let now_enabled = result.map(|_| !enabled).unwrap_or(enabled);
            if let Some(h) = app.try_state::<TrayHandles>() {
                let _ = h.autostart.set_checked(now_enabled);
            }
            // 同步主配置
            let mut cfg = config::load(app);
            cfg.auto_start = now_enabled;
            let _ = config::save(app, &cfg);
        }
        "quit" => crate::graceful_exit(app),
        _ => {}
    }
}
