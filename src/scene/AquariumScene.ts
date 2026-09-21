/**
 * AquariumScene：场景装配与水体氛围
 * - 水色渐变背景 + 雾效（深度感）
 * - 沙地（沙丘起伏 + 双层程序化焦散）
 * - 岩石
 * - 体积光柱（加法混合，缓慢摆动）
 * - 后处理管线：Bloom → 暗角/调色 → 输出
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export type SceneQuality = 'high' | 'medium' | 'low';

/** 鱼缸空间半边界（世界单位） */
export const TANK = { x: 7.6, y: 3.9, z: 4.2 };
/** 沙地高度 */
export const SAND_Y = -4.05;

/** 随窗口宽高比更新的活动范围（z=0 平面处，由相机视锥推导） */
export interface WorldBounds {
  halfW: number;
  top: number;
  bottom: number;
}

const FOG_COLOR = new THREE.Color(0x0d4a66);

/** 生成垂直水色渐变背景纹理 */
function makeBackgroundTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 512;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0.0, '#1d7d9c');
  g.addColorStop(0.35, '#11618a');
  g.addColorStop(0.7, '#0a3d5c');
  g.addColorStop(1.0, '#052134');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 程序化焦散（经典双层迭代噪声，投射在沙地） */
const CAUSTICS_GLSL = /* glsl */ `
float caustLayer(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
`;

export class AquariumScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  /** 共享时间 uniform（沙地焦散 / 光柱 / 水草共用） */
  readonly timeUniform = { value: 0 };

  private bloomPass: UnrealBloomPass;
  private gradePass: ShaderPass;
  private shafts: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  private quality: SceneQuality = 'high';
  private readonly baseCamPos = new THREE.Vector3(0, 0.25, 8.6);
  private bounds: WorldBounds = { halfW: 7.6, top: 3.9, bottom: -3.4 };

  constructor(container: HTMLElement, width: number, height: number) {
    // 渲染器：透明、抗锯齿、低功耗优先（设计说明书 §8）
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'low-power',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = makeBackgroundTexture();
    this.scene.fog = new THREE.Fog(FOG_COLOR, 13, 32);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    this.camera.position.copy(this.baseCamPos);
    this.computeBounds();

    this.buildSand();
    this.buildRocks();
    this.buildLightShafts();

    // 环境光 + 主光
    this.scene.add(new THREE.AmbientLight(0x9fd8ff, 0.55));
    const sun = new THREE.DirectionalLight(0xcfeeff, 1.35);
    sun.position.set(2.5, 9, 4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x3fa9c9, 0.4);
    fill.position.set(-4, -2, -3);
    this.scene.add(fill);

    // 后处理：Bloom → 暗角/调色 → 输出
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.38, 0.65, 0.72);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uStrength: { value: 0.85 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          // 轻微青蓝色调，让画面偏"水下"
          c.rgb = mix(c.rgb, c.rgb * vec3(0.94, 1.02, 1.08), 0.55);
          // 暗角
          float d = distance(vUv, vec2(0.5));
          c.rgb *= 1.0 - smoothstep(0.52, 0.95, d) * uStrength;
          gl_FragColor = vec4(c.rgb, c.a);
        }
      `,
    });
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
  }

  /** 沙地：沙丘起伏 + 双层焦散 + 距离雾 */
  private buildSand(): void {
    const geo = new THREE.PlaneGeometry(30, 18, 72, 52);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeUniform,
        uFogColor: { value: FOG_COLOR },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vH;
        float dune(vec2 p) {
          return sin(p.x * 0.55) * 0.26
               + cos(p.y * 0.72 + 1.7) * 0.2
               + sin(p.x * 1.7 + p.y * 1.1) * 0.07;
        }
        void main() {
          vec3 pos = position;
          float h = dune(pos.xz);
          pos.y += h;
          vH = h;
          float e = 0.4;
          float hx = dune(pos.xz + vec2(e, 0.0));
          float hz = dune(pos.xz + vec2(0.0, e));
          vNormal = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));
          vec4 world = modelMatrix * vec4(pos, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uFogColor;
        varying vec3 vWorld;
        varying vec3 vNormal;
        varying float vH;
        ${CAUSTICS_GLSL}
        void main() {
          vec3 base = mix(vec3(0.78, 0.7, 0.5), vec3(0.52, 0.48, 0.35), smoothstep(0.3, -0.45, vH));
          float diff = max(dot(normalize(vNormal), normalize(vec3(0.25, 0.85, 0.4))), 0.0);
          float c1 = caustLayer(vWorld.xz * 0.16, uTime * 0.55);
          float c2 = caustLayer(vWorld.xz * 0.11 + 13.7, uTime * 0.4 + 7.0);
          float caus = (c1 + c2) * 0.5;
          vec3 col = base * (0.4 + 0.72 * diff) + vec3(0.62, 0.86, 0.95) * caus * 0.55;
          float fogF = smoothstep(10.0, 27.0, distance(vWorld, vec3(0.0, 0.0, 8.6)));
          col = mix(col, uFogColor, fogF);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const sand = new THREE.Mesh(geo, mat);
    sand.position.y = SAND_Y;
    this.scene.add(sand);
  }

  /** 岩石：低多边形 icosahedron，散落在沙地 */
  private buildRocks(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5a62,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    });
    const defs: Array<[number, number, number, number]> = [
      [-5.6, SAND_Y + 0.32, -2.6, 0.9],
      [-4.4, SAND_Y + 0.2, -1.4, 0.55],
      [5.9, SAND_Y + 0.4, -2.2, 1.05],
      [4.7, SAND_Y + 0.18, -0.6, 0.5],
      [0.4, SAND_Y + 0.22, -3.6, 0.62],
      [2.2, SAND_Y + 0.14, 0.8, 0.34],
    ];
    for (const [x, y, z, r] of defs) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mat);
      rock.position.set(x, y, z);
      rock.rotation.set(Math.random() * 0.6, Math.random() * Math.PI, Math.random() * 0.6);
      rock.scale.y = 0.7 + Math.random() * 0.25;
      this.scene.add(rock);
    }
  }

  /** 体积光柱：加法混合长条面片，自顶部渐弱，缓慢脉动 */
  private buildLightShafts(): void {
    for (let i = 0; i < 7; i++) {
      const w = 0.5 + Math.random() * 1.2;
      const geo = new THREE.PlaneGeometry(w, 10.5);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: this.timeUniform,
          uPhase: { value: Math.random() * Math.PI * 2 },
          uColor: { value: new THREE.Color(0xbfe8ff) },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uPhase;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float edge = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 2.0);
            float vert = smoothstep(0.02, 1.0, vUv.y);
            float pulse = 0.55 + 0.45 * sin(uTime * 0.5 + uPhase);
            gl_FragColor = vec4(uColor, edge * vert * pulse * 0.16);
          }
        `,
      });
      const shaft = new THREE.Mesh(geo, mat);
      const spread = THREE.MathUtils.clamp(this.bounds.halfW / 7.6, 0.45, 1.7);
      shaft.position.set((-5.4 + i * 1.8) * spread + (Math.random() - 0.5) * 0.8, 0.7, -2.6 - Math.random() * 1.4);
      shaft.rotation.z = 0.16 + Math.random() * 0.12;
      shaft.rotation.y = (Math.random() - 0.5) * 0.5;
      this.shafts.push(shaft);
      this.scene.add(shaft);
    }
  }

  /** 依据相机视锥计算 z=0 平面可视范围（随宽高比自适应） */
  private computeBounds(): void {
    const dist = this.baseCamPos.z;
    const visH = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * dist;
    const visW = visH * this.camera.aspect;
    this.bounds = {
      halfW: Math.max(2.1, visW / 2 - 0.35),
      top: Math.min(visH / 2 - 0.35, 4.4),
      bottom: Math.max(-visH / 2 + 0.55, SAND_Y + 0.55),
    };
  }

  getBounds(): WorldBounds {
    return this.bounds;
  }

  /** 相机呼吸式漂移（不影响任何交互） */
  updateCamera(time: number): void {
    this.camera.position.set(
      this.baseCamPos.x + Math.sin(time * 0.11) * 0.05,
      this.baseCamPos.y + Math.sin(time * 0.17 + 1.2) * 0.03,
      this.baseCamPos.z + Math.sin(time * 0.07 + 2.1) * 0.02,
    );
    this.camera.lookAt(0, 0, 0);
  }

  setQuality(q: SceneQuality): void {
    this.quality = q;
    // 三档画质差异可见：高=原生分辨率+Bloom+调色，中=≤1.5x+Bloom，低=1x+无Bloom/光柱
    this.bloomPass.enabled = q !== 'low';
    this.gradePass.enabled = q === 'high';
    for (const s of this.shafts) s.visible = q !== 'low';
    const ratio =
      q === 'high'
        ? Math.min(window.devicePixelRatio, 2)
        : q === 'medium'
          ? Math.min(window.devicePixelRatio, 1.5)
          : 1;
    this.renderer.setPixelRatio(ratio);
    // composer 的像素比必须与 renderer 同步，否则后处理渲染目标分辨率与主画布不一致
    this.composer.setPixelRatio(ratio);
  }

  getQuality(): SceneQuality {
    return this.quality;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.computeBounds();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }
}
