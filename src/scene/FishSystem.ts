/**
 * FishSystem：3D Boids 鱼群 + 状态机 + 程序化鱼模型
 * - 鱼模型：程序化几何（球体压扁 + 尾鳍/背鳍）+ Canvas 纹理（条纹/渐变/眼睛），免外部资产
 * - 摆尾：onBeforeCompile 注入顶点着色器，频率与速度相关、幅度与体型相关
 * - 行为：wander + separation + alignment + cohesion + avoid + seek（权重可配）
 * - 状态机：WANDER → SEEK → DASH → REST → WANDER，任意状态可进 AVOID
 * - LOD：远景鱼降低行为更新频率；近景鱼偶尔穿越屏幕边缘
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TANK, type WorldBounds } from './AquariumScene';
import type { FishSpecies } from '../types';

export enum FishState {
  WANDER = 0,
  SEEK = 1,
  DASH = 2,
  REST = 3,
  AVOID = 4,
}

/** 鱼种外观与运动参数定义 */
interface SpeciesDef {
  bodyBase: string;
  bodyDeep: string;
  bands: Array<{ u: number; w: number; color: string; edge?: string }>;
  finColor: string;
  tail: 'fan' | 'fork' | 'round';
  dorsalH: number;
  sizeMin: number;
  sizeMax: number;
  maxSpeed: number;
}

const SPECIES: Record<FishSpecies, SpeciesDef> = {
  clownfish: {
    bodyBase: '#ff8c1a',
    bodyDeep: '#e96a08',
    bands: [
      { u: 0.22, w: 0.1, color: '#ffffff', edge: '#1a1a1a' },
      { u: 0.52, w: 0.12, color: '#ffffff', edge: '#1a1a1a' },
      { u: 0.82, w: 0.08, color: '#ffffff', edge: '#1a1a1a' },
    ],
    finColor: '#ff7a1a',
    tail: 'round',
    dorsalH: 0.34,
    sizeMin: 0.5,
    sizeMax: 0.72,
    maxSpeed: 2.0,
  },
  guppy: {
    bodyBase: '#b9c6d8',
    bodyDeep: '#7d92ad',
    bands: [{ u: 0.55, w: 0.16, color: '#9fd3ff' }],
    finColor: '#ff4f86',
    tail: 'fan',
    dorsalH: 0.26,
    sizeMin: 0.38,
    sizeMax: 0.54,
    maxSpeed: 2.6,
  },
  goldfish: {
    bodyBase: '#ffc23a',
    bodyDeep: '#ff7300',
    bands: [],
    finColor: '#ffa32e',
    tail: 'fan',
    dorsalH: 0.3,
    sizeMin: 0.66,
    sizeMax: 0.92,
    maxSpeed: 1.6,
  },
};

/** 行为权重（设计说明书 §3.3.2） */
const WEIGHTS = { wander: 1.0, separation: 1.5, alignment: 0.8, cohesion: 0.6, avoid: 2.0, seek: 0.9 };
const NEIGH_DIST_SQ = 2.4 * 2.4;
const SEP_DIST_SQ = 1.0 * 1.0;
const MAX_FORCE = 5.0;
const HARD_CAP = 40;

/** 摆尾 uniforms（每条鱼独立） */
interface WagUniforms {
  uTime: { value: number };
  uPhase: { value: number };
  uAmp: { value: number };
  uFreq: { value: number };
}

interface Boid {
  species: FishSpecies;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: THREE.Vector3;
  size: number;
  maxSpeed: number;
  state: FishState;
  stateTimer: number;
  phase: number;
  depth: number; // 0 近景，1 远景
  far: boolean;
  nearPass: boolean;
  accum: number;
  roll: number;
  prevDir: THREE.Vector3;
  mesh: THREE.Mesh;
  wag: WagUniforms;
}

/** 身体 UV 重写：u = (z+1)/2，使条纹沿体轴分布、眼睛纹理左右对称生效 */
function rewriteBodyUv(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, THREE.MathUtils.clamp((pos.getZ(i) + 1) / 2, 0, 1));
  }
  uv.needsUpdate = true;
}

/** 生成鱼身纹理：渐变 + 竖向条纹 + 眼睛黑点（u=(z+1)/2, v=纬度） */
function makeBodyTexture(def: SpeciesDef): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0, def.bodyDeep); // 尾部
  g.addColorStop(0.5, def.bodyBase); // 中段
  g.addColorStop(1, def.bodyBase); // 头部
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 64);
  // 背部略深、腹部略亮（v: 1=背）
  const shade = ctx.createLinearGradient(0, 0, 0, 64);
  shade.addColorStop(0, 'rgba(0,0,0,0.22)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  shade.addColorStop(1, 'rgba(255,255,255,0.25)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 256, 64);
  // 条纹
  for (const b of def.bands) {
    const x = b.u * 256;
    const w = b.w * 256;
    if (b.edge) {
      ctx.fillStyle = b.edge;
      ctx.fillRect(x - w / 2 - 3, 0, w + 6, 64);
    }
    ctx.fillStyle = b.color;
    ctx.fillRect(x - w / 2, 0, w, 64);
  }
  // 鳞片纹理：交叠弧线（低透明度，避免噪感）
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  for (let row = 0; row < 9; row++) {
    const y = 6 + row * 6.5;
    for (let x = -7; x < 264; x += 13) {
      ctx.beginPath();
      ctx.arc(x + (row % 2) * 6.5, y, 5.5, Math.PI * 0.12, Math.PI * 0.88);
      ctx.stroke();
    }
  }
  // 鳃线
  ctx.strokeStyle = 'rgba(0,0,0,0.32)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0.74 * 256, 30, 15, -1.15, 1.15);
  ctx.stroke();
  // 眼睛：u=0.85（z=0.7 处），v≈0.59 → 画布 y=(1-v)*64≈26；uv 映射同时命中左右两侧
  ctx.fillStyle = '#101418';
  ctx.beginPath();
  ctx.arc(0.85 * 256, 26, 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(0.85 * 256 - 1.4, 24.6, 1.3, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 尾鳍：shape +x 映射为 -z（朝后） */
function tailGeometry(kind: 'fan' | 'round' | 'fork'): THREE.BufferGeometry {
  const s = new THREE.Shape();
  if (kind === 'fork') {
    s.moveTo(0, 0);
    s.lineTo(0.5, 0.4);
    s.lineTo(0.3, 0.05);
    s.lineTo(0.3, -0.05);
    s.lineTo(0.5, -0.4);
    s.lineTo(0, 0);
  } else if (kind === 'fan') {
    s.moveTo(0, 0);
    s.quadraticCurveTo(0.62, 0.5, 0.72, 0);
    s.quadraticCurveTo(0.62, -0.5, 0, 0);
  } else {
    s.moveTo(0, 0);
    s.quadraticCurveTo(0.5, 0.34, 0.56, 0);
    s.quadraticCurveTo(0.5, -0.34, 0, 0);
  }
  const geo = new THREE.ShapeGeometry(s, 6);
  geo.rotateY(Math.PI / 2);
  geo.translate(0, 0, -0.85);
  return geo;
}

/** 背鳍：shape -x 为前端（映射 +z） */
function dorsalGeometry(h: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.4, 0);
  s.quadraticCurveTo(-0.1, h, 0.15, h * 0.55);
  s.lineTo(0.42, 0);
  s.lineTo(-0.4, 0);
  const geo = new THREE.ShapeGeometry(s, 4);
  geo.rotateY(Math.PI / 2);
  geo.translate(0, 0.55, 0.05);
  return geo;
}

/** 胸鳍对：水平展开的小扇面，随摆尾着色器轻拍 */
function pectoralPairGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.34, 0.16, 0.5, -0.08);
  s.quadraticCurveTo(0.3, -0.26, 0, 0);
  const right = new THREE.ShapeGeometry(s, 4);
  right.rotateX(-Math.PI / 2);
  right.rotateY(-0.5);
  right.translate(0.24, -0.12, 0.3);
  const left = right.clone();
  left.scale(-1, 1, 1);
  return mergeGeometries([right, left])!;
}

/** 臀鳍：腹面小鳍，随摆尾轻摆 */
function analFinGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(0.14, -0.18, 0.3, -0.24);
  s.quadraticCurveTo(0.32, -0.08, 0.28, 0);
  s.lineTo(0, 0);
  const geo = new THREE.ShapeGeometry(s, 3);
  geo.rotateY(Math.PI / 2);
  geo.translate(0, -0.3, -0.2);
  return geo;
}

/**
 * 鱼鳍 UV 归一：沿生长轴映射到 v（0=根部→1=鳍缘），
 * 使鳍纹理的"根部不透明→边缘半透明 + 放射鳍条"正确贴合。
 * radial=true 时按 |x| 映射（适用于左右对称展开的胸鳍）。
 */
function mapFinUv(geo: THREE.BufferGeometry, axis: 'x' | 'y', radial = false): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const alongMin = axis === 'x' ? bb.min.x : bb.min.y;
  const alongMax = axis === 'x' ? bb.max.x : bb.max.y;
  const oMin = axis === 'x' ? bb.min.y : bb.min.x;
  const oMax = axis === 'x' ? bb.max.y : bb.max.x;
  const span = Math.max(1e-5, alongMax - alongMin);
  const oSpan = Math.max(1e-5, oMax - oMin);
  for (let i = 0; i < uv.count; i++) {
    const a = axis === 'x' ? pos.getX(i) : pos.getY(i);
    const b = axis === 'x' ? pos.getY(i) : pos.getX(i);
    const v = radial ? Math.abs(pos.getX(i)) / Math.max(1e-5, Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x))) : (a - alongMin) / span;
    uv.setXY(i, THREE.MathUtils.clamp((b - oMin) / oSpan, 0, 1), THREE.MathUtils.clamp(v, 0, 1));
  }
  uv.needsUpdate = true;
}

/** 鳍纹理：根部不透明→边缘半透明 + 放射鳍条（真实鱼鳍的透光质感） */
function makeFinTexture(color: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 128, 128);
  // 鳍条：由根部向边缘的放射细线
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i <= 6; i++) {
    const x = 4 + i * 20;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.quadraticCurveTo(x + 6, 64, x + 12, 128);
    ctx.stroke();
  }
  // 边缘渐隐（destination-in 保留颜色并应用 alpha 梯度）
  const fade = ctx.createLinearGradient(0, 0, 0, 128);
  fade.addColorStop(0, 'rgba(255,255,255,1)');
  fade.addColorStop(0.7, 'rgba(255,255,255,0.7)');
  fade.addColorStop(1, 'rgba(255,255,255,0.32)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 注入顶点摆尾着色器（保留 Lambert 光照与雾效） */
function injectWag(mat: THREE.Material, u: WagUniforms): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uPhase = u.uPhase;
    shader.uniforms.uAmp = u.uAmp;
    shader.uniforms.uFreq = u.uFreq;
    shader.vertexShader =
      'uniform float uTime;\nuniform float uPhase;\nuniform float uAmp;\nuniform float uFreq;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        float wTail = smoothstep(0.35, -0.95, position.z);
        float wBody = smoothstep(0.75, -0.35, position.z);
        transformed.x += sin(uTime * uFreq + uPhase) * uAmp * wTail;
        transformed.x += sin(uTime * uFreq * 0.5 + uPhase + 1.3) * uAmp * 0.3 * wBody;
        float wPec = smoothstep(0.14, 0.32, position.z) * smoothstep(0.06, 0.22, abs(position.x));
        transformed.y += sin(uTime * uFreq * 1.35 + uPhase + 2.0) * 0.075 * wPec * sign(position.x);
      `,
      );
  };
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class FishSystem {
  private scene: THREE.Scene | null = null;
  private active: Boid[] = [];
  private pool: Boid[] = [];
  private geoCache = new Map<FishSpecies, THREE.BufferGeometry>();
  private matCache = new Map<FishSpecies, { body: THREE.MeshPhongMaterial; fin: THREE.MeshPhongMaterial }>();
  private species: FishSpecies[] = ['clownfish'];
  private speciesIdx = 0;
  private speed = 1.0;
  private quality: 'high' | 'medium' | 'low' = 'high';
  private frame = 0;

  private bounds: WorldBounds = { halfW: 7.6, top: 3.9, bottom: -3.4 };
  private qRoll = new THREE.Quaternion();
  private readonly AXIS_FORWARD = new THREE.Vector3(0, 0, 1);
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private sep = new THREE.Vector3();
  private ali = new THREE.Vector3();
  private coh = new THREE.Vector3();
  private acc = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private dummy = new THREE.Object3D();

  init(scene: THREE.Scene, count: number, species: FishSpecies[]): void {
    this.scene = scene;
    if (species.length > 0) this.species = species;
    this.setCount(count);
  }

  /** 获取或构建某鱼种的共享几何与基础材质 */
  private getSpeciesAssets(key: FishSpecies): { geo: THREE.BufferGeometry; body: THREE.MeshPhongMaterial; fin: THREE.MeshPhongMaterial } {
    let geo = this.geoCache.get(key);
    if (!geo) {
      const def = SPECIES[key];
      const body = new THREE.SphereGeometry(1, 24, 16);
      // 纺锤形改造：按体轴位置缩放半径，头圆尾细（替代简单椭球，显著提升鱼形逼真度）
      const bp = body.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < bp.count; i++) {
        const u = THREE.MathUtils.clamp((bp.getZ(i) + 1) / 2, 0.02, 0.98);
        const s = Math.pow(Math.sin(Math.PI * u), 0.62) * 0.94 + 0.06;
        bp.setX(i, bp.getX(i) * s);
        bp.setY(i, bp.getY(i) * s);
      }
      body.scale(0.46, 0.62, 1.0);
      body.computeVertexNormals();
      rewriteBodyUv(body);
      // 各鳍分别做 UV 归一后合并（共享同一张鳍纹理）
      const tail = tailGeometry(def.tail);
      mapFinUv(tail, 'x');
      const dorsal = dorsalGeometry(def.dorsalH);
      mapFinUv(dorsal, 'y');
      const pectoral = pectoralPairGeometry();
      mapFinUv(pectoral, 'x', true);
      const anal = analFinGeometry();
      mapFinUv(anal, 'y');
      const fins = mergeGeometries([tail, dorsal, pectoral, anal])!;
      [tail, dorsal, pectoral, anal].forEach((g) => g.dispose());
      geo = mergeGeometries([body, fins], true)!;
      body.dispose();
      fins.dispose();
      this.geoCache.set(key, geo);
    }
    let mats = this.matCache.get(key);
    if (!mats) {
      const def = SPECIES[key];
      mats = {
        // Phong 高光：湿润体表反光，显著提升"真实感"
        body: new THREE.MeshPhongMaterial({ map: makeBodyTexture(def), shininess: 30, specular: new THREE.Color(0x2e4a55) }),
        fin: new THREE.MeshPhongMaterial({
          map: makeFinTexture(def.finColor),
          side: THREE.DoubleSide,
          transparent: true,
          shininess: 10,
          specular: new THREE.Color(0x1e3038),
        }),
      };
      this.matCache.set(key, mats);
    }
    return { geo, ...mats };
  }

  private spawnFish(): Boid {
    const key = this.species[this.speciesIdx++ % this.species.length];
    const def = SPECIES[key];
    const { geo, body, fin } = this.getSpeciesAssets(key);

    const depth = Math.random();
    const far = depth > 0.6;
    const size = rand(def.sizeMin, def.sizeMax) * (far ? 0.8 : 1);

    const wag: WagUniforms = {
      uTime: { value: 0 },
      uPhase: { value: Math.random() * Math.PI * 2 },
      uAmp: { value: 0.1 + size * 0.06 },
      uFreq: { value: rand(4, 6) },
    };
    const bodyMat = body.clone();
    const finMat = fin.clone();
    injectWag(bodyMat, wag);
    injectWag(finMat, wag);

    const mesh = new THREE.Mesh(geo, [bodyMat, finMat]);
    mesh.scale.setScalar(size);
    mesh.frustumCulled = false;

    const boid: Boid = {
      species: key,
      pos: new THREE.Vector3(rand(-this.bounds.halfW + 1, this.bounds.halfW - 1), rand(this.bounds.bottom + 1.1, this.bounds.top - 0.8), far ? rand(-4, -1.5) : rand(-2, 3.5)),
      vel: new THREE.Vector3(rand(-1, 1), rand(-0.2, 0.2), rand(-1, 1)).normalize().multiplyScalar(def.maxSpeed * 0.5),
      target: new THREE.Vector3(),
      size,
      maxSpeed: def.maxSpeed,
      state: FishState.WANDER,
      stateTimer: rand(1, 5),
      phase: Math.random() * Math.PI * 2,
      depth,
      far,
      nearPass: false,
      accum: 0,
      roll: 0,
      prevDir: new THREE.Vector3(0, 0, 1),
      mesh,
      wag,
    };
    this.pickTarget(boid);
    return boid;
  }

  /** 复位鱼的状态（对象池复用时调用） */
  private resetFish(f: Boid): void {
    f.pos.set(rand(-this.bounds.halfW + 1, this.bounds.halfW - 1), rand(this.bounds.bottom + 1.1, this.bounds.top - 0.8), f.far ? rand(-4, -1.5) : rand(-2, 3.5));
    f.vel.set(rand(-1, 1), rand(-0.2, 0.2), rand(-1, 1)).normalize().multiplyScalar(f.maxSpeed * 0.5);
    f.roll = 0;
    f.prevDir.set(0, 0, 1);
    f.state = FishState.WANDER;
    f.stateTimer = rand(1, 5);
    f.nearPass = false;
    this.pickTarget(f);
  }

  /** 数量控制（含对象池复用） */
  setCount(n: number): void {
    if (!this.scene) return;
    const target = THREE.MathUtils.clamp(Math.round(n), 1, HARD_CAP);
    while (this.active.length > target) {
      const f = this.active.pop()!;
      this.scene.remove(f.mesh);
      this.pool.push(f);
    }
    while (this.active.length < target) {
      const f = this.pool.pop() ?? this.spawnFish();
      this.resetFish(f);
      this.scene.add(f.mesh);
      this.active.push(f);
    }
  }

  getCount(): number {
    return this.active.length;
  }

  setSpeed(s: number): void {
    this.speed = THREE.MathUtils.clamp(s, 0.1, 3);
  }

  setQuality(q: 'high' | 'medium' | 'low'): void {
    this.quality = q;
  }

  /** 应用可视范围（窗口尺寸/宽高比变化时调用） */
  setBounds(b: WorldBounds): void {
    this.bounds = b;
  }

  /**
   * 点击惊吓：点击点附近（半径内）的鱼群四散奔逃——
   * 直接设置沿"远离点击点"方向的逃窜速度并把状态切到 DASH（冲刺期不施加寻的，
   * 鱼沿逃窜方向直冲），DASH 结束后经 REST 减速再回 WANDER，由 cohesion/alignment
   * 自然重新聚拢。反复点击只重设方向，不会累积速度。
   */
  scatter(center: THREE.Vector3): void {
    const RADIUS = 5.0;
    for (const f of this.active) {
      const d = f.pos.distanceTo(center);
      if (d > RADIUS) continue;
      // 逃跑方向：远离点击点，水平分量为主（更接近真实鱼群受惊横向逃散）
      const dir = this.tmpA;
      if (d < 0.35) dir.set(rand(-1, 1), rand(-0.3, 0.3), rand(-1, 1));
      else dir.subVectors(f.pos, center);
      dir.y *= 0.45;
      if (dir.lengthSq() < 1e-6) dir.set(rand(-1, 1), 0, rand(-1, 1));
      dir.normalize();
      // 距点击点越近越急
      const urgency = 1 - d / RADIUS;
      f.vel.copy(dir).multiplyScalar(f.maxSpeed * (1.15 + urgency * 1.05) * this.speed);
      // 逃跑目标：沿逃跑方向随机距离，约束在活动范围内
      f.target.set(
        THREE.MathUtils.clamp(f.pos.x + dir.x * rand(3, 6), -this.bounds.halfW + 0.8, this.bounds.halfW - 0.8),
        THREE.MathUtils.clamp(f.pos.y + dir.y * rand(1.5, 3), this.bounds.bottom + 1.0, this.bounds.top - 0.7),
        THREE.MathUtils.clamp(f.pos.z + dir.z * rand(2, 4), -TANK.z + 0.7, TANK.z - 0.7),
      );
      f.state = FishState.DASH;
      f.stateTimer = rand(1.2, 2.0);
    }
  }

  /** 更换鱼种：清空对象池并重生成 */
  setSpecies(list: FishSpecies[]): void {
    if (!this.scene || list.length === 0) return;
    this.species = list;
    this.speciesIdx = 0;
    const n = this.active.length;
    for (const f of this.active) {
      this.scene.remove(f.mesh);
      (f.mesh.material as THREE.Material[]).forEach((m) => m.dispose());
    }
    for (const f of this.pool) {
      (f.mesh.material as THREE.Material[]).forEach((m) => m.dispose());
    }
    this.active = [];
    this.pool = [];
    this.setCount(n);
  }

  /** 选择巡游目标；近景鱼偶尔穿越屏幕边缘 */
  private pickTarget(f: Boid): void {
    if (f.depth < 0.35 && f.nearPass) {
      const side = Math.random() < 0.5 ? -1 : 1;
      f.target.set(side * (this.bounds.halfW + 1.8), rand(this.bounds.bottom + 1.4, this.bounds.top - 1.6), rand(-1, 3.2));
      f.nearPass = false;
      return;
    }
    f.target.set(rand(-this.bounds.halfW + 0.8, this.bounds.halfW - 0.8), rand(this.bounds.bottom + 1.0, this.bounds.top - 0.7), rand(-TANK.z + 0.7, TANK.z - 0.7));
    if (f.depth < 0.35 && Math.random() < 0.12) f.nearPass = true;
  }

  /** 单条鱼行为积分（O(n²) 邻居搜索，n ≤ 40 足够快） */
  private stepFish(f: Boid, dt: number, time: number): void {
    const acc = this.acc.set(0, 0, 0);
    const sep = this.sep.set(0, 0, 0);
    const ali = this.ali.set(0, 0, 0);
    const coh = this.coh.set(0, 0, 0);
    let neighbors = 0;

    for (const o of this.active) {
      if (o === f || o.species !== f.species) continue;
      const d2 = f.pos.distanceToSquared(o.pos);
      if (d2 < NEIGH_DIST_SQ) {
        coh.add(o.pos);
        ali.add(o.vel);
        neighbors++;
        if (d2 < SEP_DIST_SQ && d2 > 1e-6) {
          this.tmpA.subVectors(f.pos, o.pos).divideScalar(d2);
          sep.add(this.tmpA);
        }
      }
    }

    const steerToward = (desired: THREE.Vector3, weight: number): void => {
      desired.normalize().multiplyScalar(f.maxSpeed).sub(f.vel).clampLength(0, MAX_FORCE);
      acc.addScaledVector(desired, weight);
    };

    if (neighbors > 0) {
      coh.divideScalar(neighbors).sub(f.pos);
      steerToward(coh, WEIGHTS.cohesion);
      steerToward(ali, WEIGHTS.alignment);
      steerToward(sep, WEIGHTS.separation);
    }

    // 巡游 / 追踪目标
    if (f.state !== FishState.REST && f.state !== FishState.DASH) {
      if (f.pos.distanceToSquared(f.target) < 0.81) this.pickTarget(f);
      this.tmpB.subVectors(f.target, f.pos);
      steerToward(this.tmpB, WEIGHTS.seek + WEIGHTS.wander * 0.3);
    }

    // 轻微随机扰动（wander）
    acc.x += Math.sin(time * 0.9 + f.phase) * 0.35;
    acc.y += Math.sin(time * 0.7 + f.phase * 2.0) * 0.22;
    acc.z += Math.cos(time * 0.8 + f.phase) * 0.3;

    // 边界软避让（近景穿越时不施加 x 边界力）
    const hw = this.bounds.halfW;
    const top = this.bounds.top;
    const bot = this.bounds.bottom;
    const passThrough = Math.abs(f.target.x) > hw - 0.5;
    const k = 3.2;
    if (!passThrough) {
      if (f.pos.x > hw - 0.9) acc.x -= (f.pos.x - (hw - 0.9)) * k * WEIGHTS.avoid;
      if (f.pos.x < -hw + 0.9) acc.x -= (f.pos.x + (hw - 0.9)) * k * WEIGHTS.avoid;
    }
    if (f.pos.y > top - 0.7) acc.y -= (f.pos.y - (top - 0.7)) * k * WEIGHTS.avoid;
    if (f.pos.y < bot + 0.9) acc.y -= (f.pos.y - (bot + 0.9)) * k * WEIGHTS.avoid;
    if (f.pos.z > TANK.z - 0.7) acc.z -= (f.pos.z - (TANK.z - 0.7)) * k * WEIGHTS.avoid;
    if (f.pos.z < -TANK.z + 0.7) acc.z -= (f.pos.z + (TANK.z - 0.7)) * k * WEIGHTS.avoid;

    // 速度状态系数
    let factor = 1.0;
    let minSpeed = 0.35;
    if (f.state === FishState.DASH) factor = 1.9;
    else if (f.state === FishState.SEEK) factor = 1.15;
    else if (f.state === FishState.REST) {
      factor = 0.22;
      minSpeed = 0.0;
      f.vel.multiplyScalar(Math.max(0, 1 - 2.5 * dt)); // 悬停衰减
    } else if (f.state === FishState.AVOID) factor = 1.3;

    f.vel.addScaledVector(acc, dt);
    f.vel.clampLength(minSpeed, f.maxSpeed * factor * this.speed);
    f.pos.addScaledVector(f.vel, dt);

    // 状态机（设计说明书 §6.2）
    f.stateTimer -= dt;
    switch (f.state) {
      case FishState.WANDER:
        if (f.stateTimer <= 0) {
          f.state = FishState.SEEK;
          f.stateTimer = rand(4, 9);
          this.pickTarget(f);
        }
        break;
      case FishState.SEEK:
        if (f.pos.distanceToSquared(f.target) < 0.81 || f.stateTimer <= 0) {
          if (Math.random() < 0.35) {
            f.state = FishState.DASH;
            f.stateTimer = rand(0.8, 1.5);
            this.tmpB.copy(f.vel).normalize();
            f.target.copy(f.pos).addScaledVector(this.tmpB, 4);
          } else {
            f.state = FishState.WANDER;
            f.stateTimer = rand(2, 6);
            this.pickTarget(f);
          }
        }
        break;
      case FishState.DASH:
        if (f.stateTimer <= 0) {
          f.state = FishState.REST;
          f.stateTimer = rand(1.2, 2.6);
        }
        break;
      case FishState.REST:
        if (f.stateTimer <= 0) {
          f.state = FishState.WANDER;
          f.stateTimer = rand(2, 5);
          this.pickTarget(f);
        }
        break;
      case FishState.AVOID:
        if (f.stateTimer <= 0) {
          f.state = FishState.WANDER;
          f.stateTimer = rand(2, 5);
          this.pickTarget(f);
        }
        break;
    }
    // 强边界穿越进入 AVOID
    if (
      f.state !== FishState.AVOID &&
      (Math.abs(f.pos.x) > hw - 0.25 || f.pos.y > top - 0.3 || f.pos.y < bot + 0.45 || Math.abs(f.pos.z) > TANK.z - 0.25)
    ) {
      f.state = FishState.AVOID;
      f.stateTimer = 1.0;
    }

    // 网格同步
    f.mesh.position.copy(f.pos);
    if (f.state === FishState.REST) f.mesh.position.y += Math.sin(time * 1.8 + f.phase) * 0.04;
    if (f.vel.lengthSq() > 0.002) {
      this.lookTarget.copy(f.pos).add(f.vel);
      this.dummy.position.copy(f.mesh.position);
      this.dummy.lookAt(this.lookTarget);
      f.mesh.quaternion.slerp(this.dummy.quaternion, 1 - Math.exp(-6 * dt));
    }
    // 转弯侧倾（banking）：由转向角速度决定，平滑趋近
    if (f.prevDir.lengthSq() > 0.01) {
      const turnY = f.prevDir.z * f.vel.x - f.prevDir.x * f.vel.z;
      const rollTarget = THREE.MathUtils.clamp(turnY * 5.0, -0.42, 0.42);
      f.roll += (rollTarget - f.roll) * Math.min(1, 5 * dt);
    }
    if (f.vel.lengthSq() > 1e-6) f.prevDir.copy(f.vel).normalize();
    if (Math.abs(f.roll) > 0.004) {
      this.qRoll.setFromAxisAngle(this.AXIS_FORWARD, f.roll);
      f.mesh.quaternion.multiply(this.qRoll);
    }
    f.wag.uTime.value = time;
    f.wag.uFreq.value = 3.0 + f.vel.length() * 2.6;
  }

  update(dt: number, time: number): void {
    this.frame++;
    for (const f of this.active) {
      // LOD：远景鱼每 3 帧更新一次（低画质下所有鱼隔帧更新）
      const interval = this.quality === 'low' ? 2 : f.far ? 3 : 1;
      f.accum += dt;
      if (this.frame % interval !== 0) continue;
      const eff = f.accum;
      f.accum = 0;
      this.stepFish(f, Math.min(eff, 0.1), time);
    }
  }

  /** 释放鱼种缓存（切换场景时调用） */
  dispose(): void {
    for (const geo of this.geoCache.values()) geo.dispose();
    this.geoCache.clear();
    for (const m of this.matCache.values()) {
      m.body.dispose();
      m.fin.dispose();
    }
    this.matCache.clear();
  }
}
