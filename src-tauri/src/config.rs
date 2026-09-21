//! 配置服务：结构定义、JSON 持久化、热更新
//!
//! 配置文件位于 Tauri app_config_dir/config.json，字段与前端 src/types.ts 保持一致。
//! set_config 保存后通过 "config-updated" 事件广播给所有渲染窗口，实现热更新。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    #[serde(alias = "fish_count")]
    pub fish_count: u32,
    #[serde(alias = "fish_species")]
    pub fish_species: Vec<String>,
    pub speed: f32,
    #[serde(alias = "plant_density")]
    pub plant_density: f32,
    pub quality: String, // "high" | "medium" | "low"
    pub fps: u32,        // 60 | 30 | 15
    #[serde(alias = "multi_monitor")]
    pub multi_monitor: bool,
    #[serde(alias = "auto_start")]
    pub auto_start: bool,
    #[serde(alias = "pause_on_fullscreen")]
    pub pause_on_fullscreen: bool,
    #[serde(alias = "interactive_mode")]
    pub interactive_mode: bool,
    pub sound: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            fish_count: 8,
            fish_species: vec![
                "clownfish".into(),
                "guppy".into(),
                "goldfish".into(),
            ],
            speed: 1.0,
            plant_density: 0.7,
            quality: "high".into(),
            fps: 60,
            multi_monitor: true,
            auto_start: true,
            pause_on_fullscreen: true,
            interactive_mode: false,
            sound: false,
        }
    }
}

/// 配置文件路径：app_config_dir/config.json
pub fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("config.json")
}

/// 从磁盘加载配置，失败或不存在时返回默认值
pub fn load(app: &AppHandle) -> Config {
    let path = config_path(app);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

/// 保存配置到磁盘
pub fn save(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app);
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// 保存并广播热更新事件到所有渲染窗口
pub fn save_and_broadcast(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    save(app, cfg)?;
    app.emit("config-updated", cfg).map_err(|e| e.to_string())
}
