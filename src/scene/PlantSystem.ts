/**
 * PlantSystem：实例化水草丛
 * - 3 套程序化"草丛"模板（每丛 6-9 片收尖弯曲叶片），3 个 InstancedMesh 共约 500 丛（3 个 draw call）
 * - 顶点着色器摆动：丛内每片叶片带相位偏移（position.x*4.0），不同步摆动，更接近真实水流响应
 * - 根部压暗、叶尖提亮的片元渐变，模拟水下光照衰减
 * - setDensity 通过 mesh.count 调整数量，零重建开销
 * - setBounds 按可视范围重新铺排（窗口尺寸/宽高比变化时自适应）
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SAND_Y, type WorldBounds } from './AquariumScene';

const MAX_CLUSTERS = 501;
const MESH_COUNT = 3;
const PER_MESH = Math.ceil(MAX_CLUSTERS / MESH_COUNT);

const GREENS = [0x2f8f4e, 0x3fae5f, 0x256b3f, 0x46c07a, 0x1f7a5c, 0x35946b, 0x2a7d55];

export class PlantSystem {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private timeUniform = { value: 0 };
  private density = 0.7;
  private bounds: WorldBounds = { halfW: 7.6, top: 3.9, bottom: -3.4 };

  init(scene: THREE.Scene): void {
    this.build();
    this.applyDensity();
    scene.add(this.group);
  }

  /** 应用可视范围并重新铺排（窗口尺寸/宽高比变化时自适应） */
  setBounds(b: WorldBounds): void {
    this.bounds = b;
    if (this.meshes.length > 0) this.layoutInstances();
  }

  /** 单片叶片：纵向细分平面，逐段收尖并带弯曲弧度 */
  private buildBladeGeometry(width: number, bend: number): THREE.BufferGeometry {
    const blade = new THREE.PlaneGeometry(width, 1, 1, 10);
    blade.translate(0, 0.5, 0);
    const bp = blade.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) {
      const t = bp.getY(i); // 0 根部 → 1 叶尖
      bp.setX(i, bp.getX(i) * (1 - 0.82 * t * t));
      bp.setZ(i, Math.sin(t * Math.PI) * 0.04 + t * t * bend);
    }
    blade.computeVertexNormals();
    return blade;
  }

  /** 一丛水草：6-9 片叶片从根部呈扇形展开，各带随机倾角/高度/弯曲 */
  private buildClusterGeometry(): THREE.BufferGeometry {
    const blades: THREE.BufferGeometry[] = [];
    const n = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      const blade = this.buildBladeGeometry(0.12 + Math.random() * 0.1, 0.08 + Math.random() * 0.18);
      const m = new THREE.Matrix4()
        .makeRotationY((i / n) * Math.PI * 2 + Math.random() * 0.6)
        .multiply(new THREE.Matrix4().makeRotationX(-(0.1 + Math.random() * 0.38)))
        .multiply(new THREE.Matrix4().makeScale(1, 0.7 + Math.random() * 0.5, 1));
      blade.applyMatrix4(m);
      blades.push(blade);
    }
    const cluster = mergeGeometries(blades)!;
    blades.forEach((b) => b.dispose());
    return cluster;
  }

  private build(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    // 注入顶点摆动着色器 + 根部压暗渐变
    const uTime = this.timeUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader =
        /* glsl */ `
        attribute float aPhase;
        attribute float aSpeed;
        attribute float aAmp;
        uniform float uTime;
        varying float vT;
      ` +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vT = clamp(transformed.y, 0.0, 1.0);
          float hFact = pow(vT, 1.4);
          // 丛内每片叶片按局部 x 位置获得相位偏移，避免整丛同步摆动
          float sway = sin(uTime * aSpeed + aPhase + transformed.y * 2.2 + position.x * 4.0) * aAmp * hFact;
          sway += sin(uTime * 0.6 + aPhase * 1.71 + position.x * 2.0) * 0.06 * hFact;
          transformed.x += sway;
          transformed.z += sway * 0.55;
        `,
        );
      shader.fragmentShader =
        'varying float vT;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          // 根部压暗、叶尖提亮，模拟水下光照衰减
          diffuseColor.rgb *= mix(0.45, 1.12, vT);
        `,
        );
    };

    for (let j = 0; j < MESH_COUNT; j++) {
      const geo = this.buildClusterGeometry();
      const aPhase = new Float32Array(PER_MESH);
      const aSpeed = new Float32Array(PER_MESH);
      const aAmp = new Float32Array(PER_MESH);
      for (let i = 0; i < PER_MESH; i++) {
        aPhase[i] = Math.random() * Math.PI * 2;
        aSpeed[i] = 0.9 + Math.random() * 1.4;
        aAmp[i] = 0.09 + Math.random() * 0.15;
      }
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
      geo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(aSpeed, 1));
      geo.setAttribute('aAmp', new THREE.InstancedBufferAttribute(aAmp, 1));
      const mesh = new THREE.InstancedMesh(geo, mat, PER_MESH);
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.layoutInstances();
  }

  /** 按当前可视范围铺排实例：位置、朝向、高度（宽度/高度随窗口自适应） */
  private layoutInstances(): void {
    if (this.meshes.length === 0) return;
    const { halfW, top, bottom } = this.bounds;
    // 草高随可视高度缩放，避免小屏上水草顶出画面
    const hScale = THREE.MathUtils.clamp((top - bottom) / 7.3, 0.45, 1.15);

    // 聚簇分布：8 个簇，70% 在后半场，30% 前场两侧，形成前后层次
    const clusters: Array<[number, number]> = [];
    for (let c = 0; c < 8; c++) {
      clusters.push([
        (Math.random() - 0.5) * Math.max(2.4, halfW * 2 - 1.6),
        Math.random() < 0.7 ? -1.2 - Math.random() * 2.6 : 0.6 + Math.random() * 1.0,
      ]);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const axisY = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();

    for (let j = 0; j < this.meshes.length; j++) {
      const mesh = this.meshes[j];
      for (let i = 0; i < PER_MESH; i++) {
        const gi = j * PER_MESH + i;
        const [cx, cz] = clusters[gi % clusters.length];
        pos.set(
          THREE.MathUtils.clamp(cx + (Math.random() - 0.5) * 2.6, -halfW + 0.4, halfW - 0.4),
          SAND_Y + 0.02,
          THREE.MathUtils.clamp(cz + (Math.random() - 0.5) * 1.6, -4.1, 1.6),
        );
        q.setFromAxisAngle(axisY, Math.random() * Math.PI * 2);
        let height = (0.65 + Math.pow(Math.random(), 1.5) * 2.1) * hScale;
        if (pos.z < -0.5) height *= 1.25;
        scl.set(0.75 + Math.random() * 0.9, height, 1);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);

        color.setHex(GREENS[Math.floor(Math.random() * GREENS.length)]);
        color.offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.08);
        mesh.setColorAt(i, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 密度 0.1~1.0 → 渲染丛数 51~501 */
  setDensity(d: number): void {
    this.density = THREE.MathUtils.clamp(d, 0.1, 1);
    this.applyDensity();
  }

  private applyDensity(): void {
    const per = Math.max(Math.ceil(50 / MESH_COUNT), Math.floor(PER_MESH * this.density));
    for (const mesh of this.meshes) mesh.count = per;
  }

  getDensity(): number {
    return this.density;
  }

  update(time: number): void {
    this.timeUniform.value = time;
  }
}
