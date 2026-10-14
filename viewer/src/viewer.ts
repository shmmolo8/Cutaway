import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ComponentModel } from "./model";

/** Per-frame hook; return true while animating (forces another render). */
type FrameCallback = (dt: number) => boolean | void;

/** Renderer, camera, controls, environment and the frame loop. Component-agnostic. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly container: HTMLElement;
  model: ComponentModel | null = null;
  private frameCallbacks = new Set<FrameCallback>();
  private dirty = true;
  /** Pixels at the bottom covered by an overlay (the physics readout); framing avoids them. */
  private insetBottom = 0;
  /** Frames rendered so far (tests wait on this). */
  frameCount = 0;
  /** Multiplies animation time (tests set 0 to freeze a sequence while a slow screenshot runs). */
  timeScale = 1;
  private timer = new THREE.Timer();
  private cameraTween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number; dur: number } | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // 1 unit = 1 mm: components are ~0.5-3 mm, so near/far are sized for that.
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.005, 60);
    this.camera.position.set(2, 1.5, 2.5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 25;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => this.invalidate());

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.0;
    this.scene.background = new THREE.Color(getComputedStyle(document.documentElement)
      .getPropertyValue("--viewport-bg").trim() || "#20242b");
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(2, 4, 3);
    this.scene.add(key);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Match the 3D background to the page theme (reads --viewport-bg). */
  syncBackground(): void {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--viewport-bg").trim();
    (this.scene.background as THREE.Color).set(bg || "#20242b");
    this.invalidate();
  }

  setModel(model: ComponentModel): void {
    if (this.model) {
      this.scene.remove(this.model.group);
      this.model.dispose();
    }
    this.model = model;
    this.scene.add(model.group);
    this.invalidate();
  }

  /** Request a render on the next animation frame (rendering is on demand). */
  invalidate(): void {
    this.dirty = true;
  }

  onFrame(cb: FrameCallback): () => void {
    this.frameCallbacks.add(cb);
    return () => this.frameCallbacks.delete(cb);
  }

  /** Reserve `px` at the bottom: the view shifts up so the scene centres in the area above. */
  setInsetBottom(px: number): void {
    px = Math.round(px);
    if (px === this.insetBottom) return;
    this.insetBottom = px;
    this.applyViewOffset();
    this.invalidate();
  }

  private usableHeight(): number {
    const h = this.container.clientHeight || 1;
    return this.insetBottom > 0 && this.insetBottom < h * 0.6 ? (h - this.insetBottom) / h : 1;
  }

  private applyViewOffset(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    if (this.usableHeight() < 1) this.camera.setViewOffset(w, h, 0, this.insetBottom / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Place the camera along `dirWorld` from the box centre so the box fills the view. */
  frameBox(box: THREE.Box3, dirWorld: THREE.Vector3, opts: { animate?: boolean; margin?: number } = {}): void {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dir = dirWorld.clone().normalize();
    // fit the projected box extent in both view axes
    const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    const corners = boxCorners(box);
    let halfW = 0, halfH = 0, halfD = 0;
    for (const c of corners) {
      const d = c.clone().sub(center);
      halfW = Math.max(halfW, Math.abs(d.dot(right)));
      halfH = Math.max(halfH, Math.abs(d.dot(trueUp)));
      halfD = Math.max(halfD, Math.abs(d.dot(dir)));
    }
    const margin = opts.margin ?? 1.15;
    const vfov = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.usableHeight());
    const hfov = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect);
    const dist = Math.max(halfH / Math.tan(vfov), halfW / Math.tan(hfov)) * margin + halfD;
    const pos = center.clone().addScaledVector(dir, Math.max(dist, size.length() * 0.3));
    // OrbitControls clamps to maxDistance on update(): leave room for large (exploded) parts
    this.controls.maxDistance = Math.max(this.controls.maxDistance, 2 * pos.distanceTo(center));
    const far = 2 * (this.controls.maxDistance + size.length());
    if (far > this.camera.far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.up.copy(Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0));
    if (opts.animate) {
      this.cameraTween = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: center, t: 0, dur: 0.7 };
    } else {
      this.cameraTween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(center);
      this.controls.update();
    }
    this.invalidate();
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.invalidate();
  }

  private frame(time: number): void {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.5) * this.timeScale;   // real time; cap tab-resume jumps
    let animating = false;
    if (this.cameraTween) {
      const tw = this.cameraTween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = easeInOut(tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.tFrom, tw.tTo, e);
      if (tw.t >= 1) this.cameraTween = null;
      animating = true;
    }
    for (const cb of this.frameCallbacks) if (cb(dt)) animating = true;
    if (this.controls.update()) animating = true;
    if (!this.dirty && !animating) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.frameCount++;
  }
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function boxCorners(b: THREE.Box3): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z])
    out.push(new THREE.Vector3(x, y, z));
  return out;
}
