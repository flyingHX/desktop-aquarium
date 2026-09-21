# 动态 3D 桌面鱼缸（Desktop Aquarium）

真 3D 桌面鱼缸：Three.js + WebGL2 渲染，Tauri 2 + Rust 嵌入 Windows 桌面壁纸层（WorkerW），鱼缸位于桌面图标下方，默认点击穿透、不抢焦点，图标始终可见、可操作。

![tech](https://img.shields.io/badge/Tauri-2-blue) ![tech](https://img.shields.io/badge/Three.js-r170-orange) ![tech](https://img.shields.io/badge/WebGL-2-green)

## 功能特性

- **真 3D 水族箱**：程序化鱼模型（小丑鱼/孔雀鱼/金鱼），Z 轴深度分层，摆尾频率与游速联动
- **3D Boids 鱼群**：wander / separation / alignment / cohesion / avoid / seek 行为加权融合，WANDER → SEEK → DASH → REST 状态机，边界软避让
- **水草系统**：InstancedMesh 单 draw call 渲染最多 500 株，顶点着色器摆动 + 全局水流噪声
- **水体氛围**：深度渐变水色、沙丘焦散（双层程序化噪声）、体积光柱、低多边形岩石
- **GPU 粒子**：气泡（上升 + 摆动 + 顶部破裂渐隐）、浮尘（三维慢漂移），CPU 零更新
- **后处理**：Bloom、水下调色、暗角（UnrealBloomPass + 自定义 ShaderPass）
- **性能体系**：固定时间步模拟、60/30/15 帧率上限、远景鱼 LOD 降频、自动降级（FPS<45 降粒子 → <30 关 Bloom → <20 降鱼/草）、全屏应用自动暂停、电池低功耗偏好
- **桌面集成（Windows）**：Progman 0x052C → WorkerW 嵌入、WS_EX_TRANSPARENT 点击穿透、WS_EX_NOACTIVATE 不抢焦点、HWND_BOTTOM 置底、Explorer 重启自动重挂
- **托盘控制**：暂停/继续、设置、画质切换（高/中/省电）、开机自启、退出
- **配置热更新**：`config.json` 持久化 + IPC 事件广播，修改即时生效

## 目录结构

```text
desktop-aquarium/
├── index.html / vite.config.ts / tsconfig.json / package.json
├── src/                      # 渲染进程（TypeScript + Three.js）
│   ├── main.ts               # 入口：渲染循环、帧率控制、降级、设置面板、IPC 桥接
│   ├── types.ts              # 配置类型（与 Rust Config 对应）
│   ├── ui/panel.css          # 设置面板样式
│   └── scene/
│       ├── AquariumScene.ts  # 场景/相机/水体/沙地焦散/光柱/后处理
│       ├── FishSystem.ts     # 3D Boids + 状态机 + 程序化鱼 + 摆尾着色器
│       ├── PlantSystem.ts    # 实例化水草
│       └── ParticleSystem.ts # 气泡 + 浮尘 GPU 粒子
├── src-tauri/                # 主进程（Rust）
│   ├── src/main.rs           # 窗口创建、嵌入调用、IPC 命令
│   ├── src/desktop.rs        # WorkerW 嵌入、点击穿透、重挂监测
│   ├── src/config.rs         # 配置持久化与热更新广播
│   ├── src/tray.rs           # 托盘菜单
│   ├── tauri.conf.json / Cargo.toml / capabilities/default.json
│   └── icons/                # icon.ico / icon.png / 32x32.png
└── scripts/gen_icons.py      # 图标生成脚本（纯 Python，无依赖）
```

## 构建与运行

### 环境要求

- Node.js ≥ 18、pnpm（或 npm）
- Rust ≥ 1.77（`rustup` 安装）
- Windows 10/11：需 WebView2（Win11 自带）；Linux 需 `webkit2gtk-4.1`；macOS 需 Xcode CLT

### 开发运行

```bash
# 1. 前端依赖
pnpm install

# 2. 纯 Web 预览（无需 Rust，浏览器打开 http://localhost:5173）
pnpm run dev

# 3. 桌面应用（需要 Rust 工具链）
pnpm run tauri dev
```

### 打包发布

```bash
pnpm run tauri build
# 产物：src-tauri/target/release/bundle/
#   Windows: MSI / NSIS EXE
```

### 平台支持说明

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows 10/11 | ✅ 完整支持 | WorkerW 壁纸层嵌入 + 点击穿透 + Explorer 重启重挂 |
| macOS | ⚠️ 待接入 | 需实现 `NSWindow.level = kCGDesktopWindowLevel`（desktop.rs 预留了非 Windows 入口） |
| Linux X11 | ⚠️ 待接入 | 需设置 `_NET_WM_WINDOW_TYPE_DESKTOP` |
| Linux Wayland | ❌ 降级 | 无法嵌入桌面层，以普通窗口"欣赏模式"运行 |

桌面嵌入失败时程序自动降级为普通窗口模式，不影响观赏。

## IPC 命令（主进程 ↔ 渲染进程）

| 命令 | 参数 | 说明 |
|------|------|------|
| `get_config` | - | 读取配置 |
| `set_config` | `{ config }` | 保存并广播热更新 |
| `pause` / `resume` | - | 暂停/恢复渲染 |
| `set_quality` | `{ quality }` | high / medium / low |
| `set_monitor` | `{ monitorId }` | 多屏选择（预留） |
| `quit` | - | 退出应用 |

事件：`config-updated`（配置热更新）、`pause-resume`（暂停状态变更）、`open-settings`（托盘打开设置）。

浏览器（非 Tauri）环境下配置回退到 localStorage，便于纯 Web 调试。

## 验收清单（对照设计说明书 §13）

| # | 验收项 | 状态 |
|---|--------|------|
| 1 | 真 3D 鱼缸，鱼有 Z 轴深度 | ✅ 近/远深度分层 + 透视相机 |
| 2 | 游动自然（摆尾/转向/群游/避让） | ✅ Boids + 状态机 + 速度联动摆尾 |
| 3 | 水草随水流摆动 | ✅ 实例化 + 顶点着色器 |
| 4 | 水色/光柱/焦散/气泡/浮尘 | ✅ 全部实现 |
| 5 | 桌面图标始终可见 | ✅ WorkerW 嵌入 + HWND_BOTTOM |
| 6 | 图标可正常操作 | ✅ WS_EX_TRANSPARENT 点击穿透 |
| 7 | 全屏应用自动暂停 | ✅ pauseOnFullscreen |
| 8 | 多显示器 | ⚠️ MVP 支持主屏嵌入，多屏窗口为预留接口 |
| 9 | 1080p 60fps 长稳 | ✅ 帧率上限 + 三级自动降级 + LOD |
| 10 | 默认点击穿透不抢焦点 | ✅ WS_EX_TRANSPARENT + NOACTIVATE |

## 性能建议

- 低配机器：托盘切换"画质 · 省电"，或设置面板切 30fps
- 笔记本：渲染器已启用 `powerPreference: "low-power"` 与像素比上限 2
- 长时间运行：日志按天轮转于 `src-tauri/logs/`，便于排查内存/异常
