/**
 * main.ts：应用入口
 * - 装配场景与各系统，固定时间步渲染循环 + 帧率上限（60/30/15）
 * - 全屏应用时暂停、页面隐藏时暂停
 * - 性能监控与自动降级（FPS<45 降粒子 → FPS<30 关 Bloom → FPS<20 降鱼/草）
 * - 设置面板（鱼数量/鱼种/速度/密度/画质/帧率）
 * - IPC 桥接：Tauri 环境 invoke/listen；浏览器环境回退 localStorage
 */
import './ui/panel.css';
import * as THREE from 'three';
import { AquariumScene } from './scene/AquariumScene';
import { FishSystem } from './scene/FishSystem';
import { PlantSystem } from './scene/PlantSystem';
import { ParticleSystem } from './scene/ParticleSystem';
import { DEFAULT_CONFIG, type Config, type FishSpecies, type Quality } from './types';

/** ---------- IPC 桥接（Tauri / 浏览器回退） ---------- */
const isTauri = typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined';

async function ipcInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
  }
  if (cmd === 'get_config') {
    try {
      const raw = localStorage.getItem('aquarium_config');
      return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  if (cmd === 'set_config' && args?.config) {
    localStorage.setItem('aquarium_config', JSON.stringify(args.config));
    window.dispatchEvent(new CustomEvent('aquarium-config-saved'));
  }
  return null;
}

async function ipcListen(event: string, handler: (payload: unknown) => void): Promise<void> {
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    await listen(event, (e) => handler(e.payload));
  } else {
    window.addEventListener(`aquarium-${event}`, (e) => handler((e as CustomEvent).detail));
  }
}

/** 前端诊断日志：Tauri 环境写入主进程日志文件，浏览器环境打印控制台 */
async function feLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): Promise<void> {
  if (!isTauri) {
    console.log(`[aquarium:${level}] ${message}`);
    return;
  }
  try {
    await ipcInvoke('frontend_log', { level, message });
  } catch {
    console.log(`[aquarium:${level}] ${message}`);
  }
}

/** 归一化配置：兼容旧版 snake_case 字段名，仅保留已知字段并做类型收窄 */
function normalizeConfig(raw: unknown): Partial<Config> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const rawSpecies = (r.fishSpecies ?? r.fish_species) as unknown;
  const species = Array.isArray(rawSpecies)
    ? (rawSpecies as string[]).filter((s) => s === 'clownfish' || s === 'guppy' || s === 'goldfish')
    : [];
  const q = r.quality;
  return {
    fishCount: Math.round(num(r.fishCount ?? r.fish_count, DEFAULT_CONFIG.fishCount)),
    fishSpecies: species.length > 0 ? (species as FishSpecies[]) : [...DEFAULT_CONFIG.fishSpecies],
    speed: num(r.speed, DEFAULT_CONFIG.speed),
    plantDensity: num(r.plantDensity ?? r.plant_density, DEFAULT_CONFIG.plantDensity),
    quality: q === 'medium' || q === 'low' ? q : 'high',
    fps: r.fps === 30 || r.fps === 15 ? r.fps : 60,
    multiMonitor: bool(r.multiMonitor ?? r.multi_monitor, DEFAULT_CONFIG.multiMonitor),
    autoStart: bool(r.autoStart ?? r.auto_start, DEFAULT_CONFIG.autoStart),
    pauseOnFullscreen: bool(r.pauseOnFullscreen ?? r.pause_on_fullscreen, DEFAULT_CONFIG.pauseOnFullscreen),
    interactiveMode: bool(r.interactiveMode ?? r.interactive_mode, DEFAULT_CONFIG.interactiveMode),
    sound: bool(r.sound, DEFAULT_CONFIG.sound),
  };
}

/** ---------- WebGL2 检测 ---------- */
function requireWebGL2(): boolean {
  const cv = document.createElement('canvas');
  return !!cv.getContext('webgl2');
}

/** ---------- 设置面板 ---------- */
function buildPanel(
  root: HTMLElement,
  config: Config,
  onApply: (c: Config) => void,
): { setPausedBadge: (p: boolean) => void; sync: () => void; open: () => void; close: () => void } {
  const panel = document.createElement('div');
  panel.className = 'aq-panel hidden';
  const status = document.createElement('div');
  status.className = 'aq-status';
  panel.appendChild(status);

  const row = (label: string): { wrap: HTMLDivElement; value: HTMLSpanElement } => {
    const wrap = document.createElement('div');
    wrap.className = 'aq-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'aq-val';
    wrap.appendChild(lab);
    wrap.appendChild(val);
    panel.appendChild(wrap);
    return { wrap, value: val };
  };

  const sliders: Array<{ key: keyof Config; label: string; min: number; max: number; step: number; fmt?: (v: number) => string }> = [
    { key: 'fishCount', label: '鱼数量', min: 1, max: 30, step: 1 },
    { key: 'speed', label: '游动速度', min: 0.3, max: 2.5, step: 0.1 },
    { key: 'plantDensity', label: '水草密度', min: 0.1, max: 1, step: 0.1 },
  ];
  const sliderRefs: Array<{ input: HTMLInputElement; value: HTMLSpanElement; cfg: (typeof sliders)[number] }> = [];

  for (const s of sliders) {
    const { value } = row(s.label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    panel.appendChild(input);
    sliderRefs.push({ input, value, cfg: s });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      value.textContent = String(v);
      config[s.key] = v as never;
    });
    input.addEventListener('change', () => onApply({ ...config }));
  }

  // 画质
  const qRow = row('画质');
  const qGroup = document.createElement('div');
  qGroup.className = 'aq-seg';
  const qBtns: Record<Quality, HTMLButtonElement> = {} as never;
  for (const q of ['high', 'medium', 'low'] as Quality[]) {
    const b = document.createElement('button');
    b.textContent = q === 'high' ? '高' : q === 'medium' ? '中' : '低';
    b.addEventListener('click', () => {
      config.quality = q;
      syncSeg();
      onApply({ ...config });
    });
    qBtns[q] = b;
    qGroup.appendChild(b);
  }
  qRow.wrap.appendChild(qGroup);
  const syncSeg = (): void => {
    for (const q of ['high', 'medium', 'low'] as Quality[]) qBtns[q].classList.toggle('active', config.quality === q);
  };

  // 帧率
  const fRow = row('帧率上限');
  const fGroup = document.createElement('div');
  fGroup.className = 'aq-seg';
  const fBtns: Record<number, HTMLButtonElement> = {} as never;
  for (const f of [60, 30, 15]) {
    const b = document.createElement('button');
    b.textContent = String(f);
    b.addEventListener('click', () => {
      config.fps = f;
      syncFps();
      onApply({ ...config });
    });
    fBtns[f] = b;
    fGroup.appendChild(b);
  }
  fRow.wrap.appendChild(fGroup);
  const syncFps = (): void => {
    for (const f of [60, 30, 15]) fBtns[f].classList.toggle('active', config.fps === f);
  };

  // 鱼种选择
  const spRow = row('鱼种');
  const spGroup = document.createElement('div');
  spGroup.className = 'aq-seg';
  const spMeta: Array<{ key: FishSpecies; label: string }> = [
    { key: 'clownfish', label: '小丑鱼' },
    { key: 'guppy', label: '孔雀鱼' },
    { key: 'goldfish', label: '金鱼' },
  ];
  const spBtns: Record<string, HTMLButtonElement> = {};
  for (const s of spMeta) {
    const b = document.createElement('button');
    b.textContent = s.label;
    b.addEventListener('click', () => {
      const idx = config.fishSpecies.indexOf(s.key);
      if (idx >= 0) {
        if (config.fishSpecies.length > 1) config.fishSpecies.splice(idx, 1);
      } else {
        config.fishSpecies.push(s.key);
      }
      syncSpecies();
      onApply({ ...config });
    });
    spBtns[s.key] = b;
    spGroup.appendChild(b);
  }
  spRow.wrap.appendChild(spGroup);
  const syncSpecies = (): void => {
    for (const s of spMeta) spBtns[s.key].classList.toggle('active', config.fishSpecies.includes(s.key));
  };

  const sync = (): void => {
    for (const { input, value, cfg } of sliderRefs) {
      input.value = String(config[cfg.key]);
      value.textContent = String(config[cfg.key]);
    }
    syncSeg();
    syncFps();
    syncSpecies();
  };
  sync();

  // 面板开关：打开面板时窗口临时进入交互模式（主进程提升窗口层级到图标之上），
  // 关闭时恢复点击穿透；入口仅有托盘"设置"菜单（穿透模式下齿轮收不到点击，已移除）
  const isOpen = (): boolean => !panel.classList.contains('hidden');
  const openPanel = (): void => {
    panel.classList.remove('hidden');
    void ipcInvoke('set_interactive', { enabled: true });
  };
  const closePanel = (): void => {
    if (!isOpen()) return;
    panel.classList.add('hidden');
    void ipcInvoke('set_interactive', { enabled: false });
  };
  // 点击面板以外的区域 → 关闭面板并恢复点击穿透
  root.addEventListener('click', (e: MouseEvent) => {
    if (!isOpen()) return;
    const t = e.target as Node;
    if (!panel.contains(t)) closePanel();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });
  root.appendChild(panel);

  return {
    setPausedBadge: (p: boolean): void => {
      status.textContent = p ? '⏸ 已暂停（全屏应用 / 托盘暂停）' : '▶ 运行中';
      status.classList.toggle('paused', p);
    },
    sync,
    open: openPanel,
    close: closePanel,
  };
}

/** ---------- 启动 ---------- */
async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const loading = document.getElementById('loading')!;

  // 诊断：JS 异常与 Promise 拒绝上报到主进程日志
  window.addEventListener('error', (e) =>
    void feLog('error', `JS 错误：${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`),
  );
  window.addEventListener('unhandledrejection', (e) =>
    void feLog('error', `未处理的 Promise 拒绝：${String((e as PromiseRejectionEvent).reason)}`),
  );

  await feLog(
    'info',
    `前端启动：isTauri=${isTauri}，viewport=${window.innerWidth}x${window.innerHeight}，WebGL2=${requireWebGL2()}`,
  );

  if (!requireWebGL2()) {
    loading.textContent = '当前环境不支持 WebGL2，无法渲染 3D 鱼缸';
    await feLog('error', '当前环境不支持 WebGL2，无法渲染 3D 鱼缸');
    return;
  }

  const scene = new AquariumScene(app, window.innerWidth, window.innerHeight);
  const fishes = new FishSystem();
  const plants = new PlantSystem();
  const particles = new ParticleSystem();

  // 应用初始可视范围（随窗口宽高比自适应）
  fishes.setBounds(scene.getBounds());
  plants.setBounds(scene.getBounds());

  plants.init(scene.scene);
  particles.init(scene.scene, scene.getQuality());
  fishes.init(scene.scene, DEFAULT_CONFIG.fishCount, DEFAULT_CONFIG.fishSpecies);
  await feLog('info', '场景/水草/粒子/鱼群初始化完成');

  // 加载配置并应用
  const config: Config = { ...DEFAULT_CONFIG, ...normalizeConfig(await ipcInvoke('get_config')) };
  // lastSpeciesKey 以"场景当前实际鱼种"（DEFAULT_CONFIG）为基准初始化，
  // 确保加载到的配置里与默认不同的鱼种在首次 applyConfig 时会触发鱼群重建
  let lastSpeciesKey = [...DEFAULT_CONFIG.fishSpecies].sort().join(',');
  /** 应用配置到场景；persist=true 时才落盘并广播（广播接收方绝不回写，避免保存→广播→再保存死循环卡死 UI） */
  const applyConfig = (c: Config, persist = false): void => {
    fishes.setCount(c.fishCount);
    fishes.setSpeed(c.speed);
    fishes.setQuality(c.quality === 'high' ? 'high' : c.quality === 'medium' ? 'medium' : 'low');
    // 仅在鱼种列表真正变化时重建鱼群（否则切画质/密度都会导致鱼群全部重生、观感为"游速突变"）
    const speciesKey = [...c.fishSpecies].sort().join(',');
    if (speciesKey !== lastSpeciesKey) {
      lastSpeciesKey = speciesKey;
      fishes.setSpecies(c.fishSpecies);
    }
    plants.setDensity(c.plantDensity);
    scene.setQuality(c.quality);
    if (c.quality === 'low') particles.setIntensity(0.4);
    else if (c.quality === 'medium') particles.setIntensity(0.7);
    else particles.setIntensity(1);
    if (persist) void ipcInvoke('set_config', { config: c });
  };
  applyConfig(config);
  await feLog(
    'debug',
    `配置已应用：fishCount=${config.fishCount} speed=${config.speed} quality=${config.quality} fps=${config.fps}`,
  );

  const panelCtl = buildPanel(app, config, (c) => applyConfig(c, true));

  // 托盘 / 主进程事件
  let pausedByTray = false;
  await ipcListen('config-updated', (payload) => {
    Object.assign(config, normalizeConfig(payload));
    applyConfig(config); // 仅应用不落盘：该事件可能来自本次 set_config 的广播，回写会形成死循环
    panelCtl.sync(); // 广播可能来自托盘/其他窗口，刷新面板滑杆与按钮选中态
  });
  // 托盘"设置"菜单 → 打开设置面板并进入交互模式
  await ipcListen('open-settings', () => panelCtl.open());
  await ipcListen('pause-resume', (payload) => {
    pausedByTray = Boolean((payload as { paused?: boolean }).paused);
  });

  /** 把客户坐标换算为世界坐标（鱼群主活动平面 z=0），触发鱼群惊吓散开 */
  const scatterAtClient = (clientX: number, clientY: number): void => {
    const rect = scene.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const world = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(scene.camera);
    const dir = world.sub(scene.camera.position).normalize();
    if (Math.abs(dir.z) < 1e-4) return;
    const t = -scene.camera.position.z / dir.z;
    if (t <= 0) return;
    const hit = scene.camera.position.clone().addScaledVector(dir, t);
    fishes.scatter(hit);
    void feLog('debug', `点击惊吓鱼群：世界坐标 (${hit.x.toFixed(2)}, ${hit.y.toFixed(2)})`);
  };

  // 真实点击通路（交互模式 / Web 预览）：点击画布区域即惊吓鱼群
  app.addEventListener('pointerdown', (e) => {
    if (e.target !== scene.renderer.domElement) return;
    scatterAtClient(e.clientX, e.clientY);
  });
  // 点击穿透通路：窗口默认穿透收不到系统点击，主进程全局鼠标钩子捕获后
  // 转发相对覆盖矩形的归一坐标（u/v ∈ 0..1），DPI 缩放在比例换算中自然抵消
  await ipcListen('canvas-click', (payload) => {
    const p = payload as { u?: number; v?: number };
    if (typeof p.u !== 'number' || typeof p.v !== 'number') return;
    const rect = scene.renderer.domElement.getBoundingClientRect();
    scatterAtClient(rect.left + p.u * rect.width, rect.top + p.v * rect.height);
  });

  /** 全屏应用检测：除本页外的全屏元素即视为"用户在全屏使用其他应用" */
  const otherFullscreenActive = (): boolean => {
    const el = document.fullscreenElement;
    return !!el && el !== scene.renderer.domElement && !app.contains(el);
  };

  // 性能监控与自动降级（设计说明书 §3.8）
  let fpsSamples: number[] = [];
  let degradeLevel = 0; // 0 无 1 降粒子 2 关 Bloom 3 降鱼/草
  let lastDegradeTime = 0;

  /** ---------- 渲染循环 ---------- */
  const FIXED_DT = 1 / 60;
  let accumulator = 0;
  let simTime = 0;
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let running = true;

  const frameCapMs = (): number => (config.fps === 15 ? 66.7 : config.fps === 30 ? 33.4 : 16.7);

  function tick(now: number): void {
    requestAnimationFrame(tick);
    const elapsed = now - last;
    if (elapsed < frameCapMs() - 2) return; // 帧率上限
    last = now;

    const fullscreenPause = config.pauseOnFullscreen && otherFullscreenActive();
    const paused = pausedByTray || fullscreenPause || document.hidden;
    panelCtl.setPausedBadge(pausedByTray || fullscreenPause);
    if (paused || !running) return;

    const dt = Math.min(elapsed / 1000, 0.1);
    accumulator += dt;
    // 固定时间步更新（渲染插值简化为直接渲染）
    while (accumulator >= FIXED_DT) {
      simTime += FIXED_DT;
      fishes.update(FIXED_DT, simTime);
      accumulator -= FIXED_DT;
    }
    plants.update(simTime);
    particles.update(simTime);
    scene.timeUniform.value = simTime;
    scene.updateCamera(simTime);

    // FPS 统计（每 2 秒评估一次）
    fpsAccum += elapsed;
    fpsFrames++;
    if (fpsAccum >= 2000) {
      const fps = (fpsFrames * 1000) / fpsAccum;
      fpsSamples.push(fps);
      if (fpsSamples.length > 5) fpsSamples.shift();
      fpsAccum = 0;
      fpsFrames = 0;

      const now2 = performance.now();
      const low = fpsSamples.every((v) => v < (degradeLevel === 0 ? 45 : degradeLevel === 1 ? 30 : 20));
      if (low && now2 - lastDegradeTime > 10000 && degradeLevel < 3) {
        degradeLevel++;
        lastDegradeTime = now2;
        if (degradeLevel === 1) particles.setIntensity(0.4);
        else if (degradeLevel === 2) scene.setQuality(config.quality === 'low' ? 'low' : 'low');
        else {
          fishes.setCount(Math.max(4, Math.round(config.fishCount * 0.6)));
          plants.setDensity(Math.max(0.3, config.plantDensity * 0.6));
        }
      }
    }

    scene.render();
  }

  requestAnimationFrame(tick);

  // 窗口尺寸自适应：resize 事件 + ResizeObserver + 轮询兜底
  // （嵌入 WorkerW 后部分场景下 resize 事件可能不触发，轮询保证最终一致）
  let lastW = window.innerWidth;
  let lastH = window.innerHeight;
  const syncSize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > 0 && h > 0 && (Math.abs(w - lastW) > 1 || Math.abs(h - lastH) > 1)) {
      lastW = w;
      lastH = h;
      scene.resize(w, h);
      fishes.setBounds(scene.getBounds());
      plants.setBounds(scene.getBounds());
      void feLog('debug', `窗口尺寸自适应：${w}x${h}`);
    }
  };
  window.addEventListener('resize', syncSize);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncSize).observe(app);
  window.setInterval(syncSize, 1500);

  // 加载遮罩淡出
  requestAnimationFrame(() => {
    loading.classList.add('hidden');
    setTimeout(() => loading.remove(), 800);
  });
}

void main();
