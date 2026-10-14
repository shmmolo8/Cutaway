import * as THREE from "three";
import type { LoadedVariant } from "./data";
import type { ComponentMeta, LayerMeta, Vec3 } from "./types";

export interface LayerView {
  meta: LayerMeta;
  index: number;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  basePosition: THREE.Vector3;
  visible: boolean;
}

/**
 * A loaded component variant. Everything here is driven by metadata; no
 * component-specific code. Layer nodes live in the CAD frame under `root`
 * (whose matrix converts CAD Z-up to three.js Y-up).
 */
export class ComponentModel {
  readonly meta: ComponentMeta;
  readonly group: THREE.Group;
  readonly root: THREE.Object3D;
  readonly layers: LayerView[] = [];
  readonly byId = new Map<string, LayerView>();
  readonly byMesh = new Map<THREE.Object3D, LayerView>();
  private explodeT = 0;

  constructor({ meta, scene }: LoadedVariant) {
    this.meta = meta;
    this.group = scene;
    const root = scene.getObjectByName(meta.component.id);
    if (!root) throw new Error(`GLB has no root node ${meta.component.id}`);
    this.root = root;

    meta.layers.forEach((lm, index) => {
      const node = root.getObjectByName(lm.id);
      const mesh = node && ((node as THREE.Mesh).isMesh ? (node as THREE.Mesh) : findMesh(node));
      if (!mesh) throw new Error(`GLB has no mesh for layer ${lm.id}`);
      const material = makeMaterial(lm);
      mesh.material = material;
      mesh.renderOrder = RENDER_ORDER_SURFACE;
      mesh.userData.layerId = lm.id;
      const view: LayerView = {
        meta: lm, index, mesh, material,
        basePosition: mesh.position.clone(), visible: true,
      };
      this.layers.push(view);
      this.byId.set(lm.id, view);
      this.byMesh.set(mesh, view);
    });
    this.group.updateMatrixWorld(true);
  }

  /** CAD-frame direction -> world direction (unit). */
  cadDirToWorld(v: Vec3): THREE.Vector3 {
    return new THREE.Vector3(...v).transformDirection(this.root.matrixWorld);
  }

  /** CAD-frame point -> world point. */
  cadPointToWorld(p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(...p).applyMatrix4(this.root.matrixWorld);
  }

  /** World bounding box of the assembled (unexploded) component, from metadata. */
  worldBox(): THREE.Box3 {
    const [a, b] = this.meta.component.bbox;
    const box = new THREE.Box3();
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]])
      box.expandByPoint(this.cadPointToWorld([x, y, z]));
    return box;
  }

  /** World box including the current explode offsets. */
  currentWorldBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const l of this.layers) if (l.visible) box.expandByObject(l.mesh);
    return box.isEmpty() ? this.worldBox() : box;
  }

  get explode(): number {
    return this.explodeT;
  }

  /**
   * Final offset = direction x step x order (CAD frame, parent-local), reached at t = 1.
   * Explode order is respected in time too: higher orders (outer shells) start first,
   * so an outer shell is always both further along and moving faster than the shell
   * it wraps; nested layers never pass through each other.
   */
  setExplode(t: number): void {
    this.explodeT = t;
    const step = this.meta.explode.step_mm;
    const maxOrder = Math.max(1, ...this.layers.map((l) => l.meta.explode.order));
    for (const l of this.layers) {
      const [dx, dy, dz] = l.meta.explode.direction;
      const k = step * l.meta.explode.order * layerProgress(t, l.meta.explode.order, maxOrder);
      l.mesh.position.set(l.basePosition.x + dx * k, l.basePosition.y + dy * k, l.basePosition.z + dz * k);
    }
    this.group.updateMatrixWorld(true);
  }

  /** World box of visible layers at explode `t` (restores the current state). */
  boxAtExplode(t: number): THREE.Box3 {
    const saved = this.explodeT;
    this.setExplode(t);
    const box = this.currentWorldBox();
    this.setExplode(saved);
    return box;
  }

  setVisible(id: string, visible: boolean): void {
    const l = this.byId.get(id);
    if (!l) return;
    l.visible = visible;
    l.mesh.visible = visible;
  }

  dispose(): void {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      l.material.dispose();
    }
  }
}

export const RENDER_ORDER_SURFACE = 10_000;

const STAGGER = 0.35;

/** Eased 0..1 progress of a layer of explode `order` at global slider value t. */
export function layerProgress(t: number, order: number, maxOrder: number): number {
  if (order <= 0) return 0;
  const delay = STAGGER * (maxOrder - order) / maxOrder;
  const u = THREE.MathUtils.clamp((t - delay) / (1 - STAGGER + 1e-9), 0, 1);
  return u * u * (3 - 2 * u);
}

function findMesh(node: THREE.Object3D): THREE.Mesh | undefined {
  let found: THREE.Mesh | undefined;
  node.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
}

export function makeMaterial(lm: LayerMeta): THREE.MeshStandardMaterial {
  const transparent = lm.opacity < 1;
  return new THREE.MeshStandardMaterial({
    name: lm.id,
    color: new THREE.Color(lm.color),
    roughness: lm.roughness,
    metalness: lm.metalness,
    opacity: lm.opacity,
    transparent,
    depthWrite: !transparent,
    side: THREE.FrontSide,
    envMapIntensity: 1.0,
  });
}
