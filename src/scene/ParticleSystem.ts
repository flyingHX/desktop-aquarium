/**
 * ParticleSystem：气泡 + 浮尘（纯 GPU 粒子）
 * - 气泡：底部生成，随机速度上升 + 左右摆动，顶部破裂渐隐；着色器内循环复用，CPU 零更新
 * - 浮尘：三维慢速漂移的小点，sin 包络天然循环
 * - setIntensity 通过 setDrawRange 调整数量，零重建开销
 */
import * as THREE from 'three';
import { SAND_Y, TANK } from './AquariumScene';

const MAX_BUBBLES = 120;
const MAX_DUST = 160;
/** 气泡发射柱 x 坐标 */
const EMITTERS = [-5.4, -2.8, 0.3, 3.0, 5.6];

export class ParticleSystem {
  readonly group = new THREE.Group();
  private bubbles: THREE.Points | null = null;
  private dust: THREE.Points | null = null;
  private timeU = { value: 0 };
  private pixelU = { value: Math.min(window.devicePixelRatio, 2) };
  private bottomU = { value: SAND_Y + 0.15 };
  private topU = { value: TANK.y - 0.1 };
  private bubbleCount = MAX_BUBBLES;
  private dustCount = MAX_DUST;

  init(scene: THREE.Scene, quality: 'high' | 'medium' | 'low'): void {
    this.buildBubbles();
    this.buildDust();
    if (quality === 'low') this.setIntensity(0.4);
    else if (quality === 'medium') this.setIntensity(0.7);
    scene.add(this.group);
  }

  private buildBubbles(): void {
    const geo = new THREE.BufferGeometry();
    const aPos = new Float32Array(MAX_BUBBLES * 3); // x0, z0, size
    const aSeed = new Float32Array(MAX_BUBBLES * 3); // phase, speedFactor, driftPhase
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const ex = EMITTERS[i % EMITTERS.length];
      aPos[i * 3] = ex + (Math.random() - 0.5) * 0.7;
      aPos[i * 3 + 1] = (Math.random() - 0.5) * 1.2;
      aPos[i * 3 + 2] = 0.05 + Math.random() * 0.13; // 点大小
      aSeed[i * 3] = Math.random();
      aSeed[i * 3 + 1] = Math.random();
      aSeed[i * 3 + 2] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BUBBLES * 3), 3));
    geo.setAttribute('aPos', new THREE.BufferAttribute(aPos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 3));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: this.timeU,
        uPixelRatio: this.pixelU,
        uBottom: this.bottomU,
        uTop: this.topU,
      },
      vertexShader: /* glsl */ `
        attribute vec3 aPos;   // x0, z0, size
        attribute vec3 aSeed;  // phase, speedFactor, driftPhase
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uBottom;
        uniform float uTop;
        varying float vAlpha;
        void main() {
          float speed = 0.45 + aSeed.y * 0.55;
          float travel = uTop - uBottom;
          float t = mod(uTime * speed + aSeed.x * travel, travel);
          float y = uBottom + t;
          float prog = t / travel;
          float x = aPos.x + sin(uTime * (0.7 + aSeed.y * 0.8) + aSeed.z * 6.2831) * (0.1 + prog * 0.32);
          float z = aPos.y + cos(uTime * 0.6 + aSeed.z * 4.0) * 0.1;
          float fadeTop = 1.0 - smoothstep(uTop - 0.55, uTop - 0.05, y); // 顶部破裂渐隐
          float fadeBot = smoothstep(uBottom, uBottom + 0.3, y);
          vAlpha = fadeTop * fadeBot * (0.55 + 0.45 * sin(aSeed.x * 43.7));
          vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
          gl_PointSize = aPos.z * (170.0 / max(-mv.z, 0.1)) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float ring = smoothstep(0.5, 0.44, d) - smoothstep(0.44, 0.30, d);
          float hl = smoothstep(0.16, 0.0, length(c - vec2(-0.12, 0.14))) * 0.85;
          float a = (ring * 0.55 + hl) * vAlpha;
          gl_FragColor = vec4(0.75, 0.92, 1.0, a);
        }
      `,
    });
    this.bubbles = new THREE.Points(geo, mat);
    this.bubbles.frustumCulled = false;
    this.group.add(this.bubbles);
  }

  private buildDust(): void {
    const geo = new THREE.BufferGeometry();
    const aBase = new Float32Array(MAX_DUST * 3);
    const aSeed = new Float32Array(MAX_DUST * 3);
    for (let i = 0; i < MAX_DUST; i++) {
      aBase[i * 3] = (Math.random() - 0.5) * 2 * TANK.x;
      aBase[i * 3 + 1] = SAND_Y + 0.4 + Math.random() * (TANK.y - SAND_Y - 0.8);
      aBase[i * 3 + 2] = (Math.random() - 0.5) * 2 * TANK.z;
      aSeed[i * 3] = Math.random() * Math.PI * 2;
      aSeed[i * 3 + 1] = Math.random();
      aSeed[i * 3 + 2] = Math.random() * Math.PI * 2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3));
    geo.setAttribute('aBase', new THREE.BufferAttribute(aBase, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 3));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.timeU, uPixelRatio: this.pixelU },
      vertexShader: /* glsl */ `
        attribute vec3 aBase;
        attribute vec3 aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vec3 p = aBase + vec3(
            sin(uTime * 0.11 + aSeed.x) * 0.9,
            sin(uTime * 0.07 + aSeed.y * 6.28) * 0.55,
            sin(uTime * 0.09 + aSeed.z) * 0.7
          );
          vAlpha = 0.14 + 0.12 * sin(uTime * 0.6 + aSeed.x * 5.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.4 + aSeed.y * 2.2) * uPixelRatio * (130.0 / max(-mv.z, 0.1));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.08, length(c)) * vAlpha;
          gl_FragColor = vec4(0.82, 0.92, 1.0, a);
        }
      `,
    });
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  /** 粒子强度 0~1（性能降级时调用） */
  setIntensity(factor: number): void {
    const f = THREE.MathUtils.clamp(factor, 0, 1);
    this.bubbleCount = Math.max(10, Math.floor(MAX_BUBBLES * f));
    this.dustCount = Math.max(20, Math.floor(MAX_DUST * f));
    this.bubbles?.geometry.setDrawRange(0, this.bubbleCount);
    this.dust?.geometry.setDrawRange(0, this.dustCount);
  }

  setPixelRatio(r: number): void {
    this.pixelU.value = r;
  }

  update(time: number): void {
    this.timeU.value = time;
  }
}
