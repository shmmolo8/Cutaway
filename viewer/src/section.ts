import * as THREE from "three";
import type { ComponentModel, LayerView } from "./model";
import type { PlaneMeta } from "./types";
import type { Viewer } from "./viewer";

/**
 * Slice plane with solid, per-layer coloured caps.
 *
 * Stencil capping as in three.js `webgl_clipping_stencil`, extended to N meshes:
 * for every visible layer i (in order)
 *   renderOrder 2i+1 : clipped BACK faces  -> stencil += 1 (wrap), no colour/depth
 *   renderOrder 2i+1 : clipped FRONT faces -> stencil -= 1 (wrap), no colour/depth
 *   renderOrder 2i+2 : cap quad on the plane, drawn where stencil != 0, in the
 *                      layer's colour; its stencil ops REPLACE with 0 and it clears
 *                      the stencil after rendering, so layer i+1 starts from zero.
 * then all clipped surfaces at RENDER_ORDER_SURFACE.
 * The stencil passes are children of each layer mesh, so they follow explode offsets.
 */
export type Axis = "X" | "Y" | "Z" | "custom";

const AXIS_CAD: Record<Exclude<Axis, "custom">, [number, number, number]> = {
  X: [-1, 0, 0], Y: [0, 1, 0], Z: [0, 0, -1],
};

interface CapSet {
  layer: LayerView;
  back: THREE.Mesh;
  front: THREE.Mesh;
  cap: THREE.Mesh;
  capMaterial: THREE.MeshStandardMaterial;
}

export class SectionTool {
  readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  /** Pose of the plane in world space: local +Z = normal. */
  readonly gizmo = new THREE.Object3D();
  enabled = false;
  axis: Axis = "Y";
  /** Signed distance (mm) of the plane from the model centre along the normal. */
  offset = 0;

  private model: ComponentModel | null = null;
  private caps: CapSet[] = [];
  private capGroup = new THREE.Group();
  private viewer: Viewer;
  private center = new THREE.Vector3();
  private extent = 1;
  private listeners = new Set<() => void>();

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.capGroup.name = "section-caps";
    viewer.scene.add(this.capGroup, this.gizmo);

    viewer.onFrame(() => this.update());
    this.setEnabled(false);
  }

  onChange(cb: () => void): void {
    this.listeners.add(cb);
  }

  private emit(): void {
    this.viewer.invalidate();
    for (const cb of this.listeners) cb();
  }

  /** Attach to a newly loaded model (keeps the current plane pose). */
  /**
   * Draw these layers' sections after all others: a layer reshaped in the viewer (e.g. a
   * thicker ceramic) can grow into a neighbour carved around its old shape, and its cap must
   * then win where both stencils are set.
   */
  drawLast(ids: string[]): void {
    const n = this.caps.length;
    ids.forEach((id, k) => {
      const c = this.caps.find((x) => x.layer.meta.id === id);
      if (!c) return;
      c.back.renderOrder = c.front.renderOrder = 2 * (n + k) + 1;
      c.cap.renderOrder = 2 * (n + k) + 2;
    });
  }

  setModel(model: ComponentModel): void {
    for (const c of this.caps) {
      c.back.removeFromParent();
      c.front.removeFromParent();
      c.cap.removeFromParent();
      (c.back.material as THREE.Material).dispose();
      (c.front.material as THREE.Material).dispose();
      c.capMaterial.dispose();
    }
    this.caps = [];
    this.model = model;
    const box = model.worldBox();
    box.getCenter(this.center);
    this.extent = box.getSize(new THREE.Vector3()).length() / 2;
    // caps must cover every layer's section even when fully exploded
    const maxOrder = Math.max(...model.layers.map((l) => l.meta.explode.order));
    const reach = this.extent + maxOrder * model.meta.explode.step_mm;
    (this.capGeometry as THREE.PlaneGeometry).dispose();
    this.capGeometry = new THREE.PlaneGeometry(reach * 4.4, reach * 4.4);

    model.layers.forEach((layer, i) => {
      const back = stencilMesh(layer.mesh.geometry, THREE.BackSide, THREE.IncrementWrapStencilOp, this.plane);
      const front = stencilMesh(layer.mesh.geometry, THREE.FrontSide, THREE.DecrementWrapStencilOp, this.plane);
      back.renderOrder = front.renderOrder = 2 * i + 1;
      layer.mesh.add(back, front);

      const capMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(layer.meta.color),
        // A section face should read as the material's colour from any angle, so
        // metals keep only part of their metalness (full metalness = env colour).
        metalness: layer.meta.metalness * 0.45,
        roughness: Math.max(layer.meta.roughness, 0.5),
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
        side: THREE.DoubleSide,
      });
      const cap = new THREE.Mesh(this.capGeometry, capMaterial);
      cap.renderOrder = 2 * i + 2;
      cap.onAfterRender = (renderer) => renderer.clearStencil();
      cap.userData.layerId = layer.meta.id;
      cap.raycast = () => {};                     // picking handles caps analytically
      this.capGroup.add(cap);
      this.caps.push({ layer, back, front, cap, capMaterial });
    });
    this.applyEnabled();
    if (this.axis !== "custom") this.setAxis(this.axis, this.offset);
    else this.placeGizmo(this.normal(), this.offset);
  }

  private capGeometry: THREE.BufferGeometry = new THREE.PlaneGeometry(1, 1);

  capMaterial(layerId: string): THREE.MeshStandardMaterial | undefined {
    return this.caps.find((c) => c.layer.meta.id === layerId)?.capMaterial;
  }

  // ------------------------------------------------------------------ controls
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyEnabled();
    this.emit();
  }

  /** Axis-aligned plane (CAD axis), `offset` mm from the model centre. */
  setAxis(axis: Axis, offset = 0): void {
    if (!this.model) return;
    this.axis = axis;
    if (axis === "custom") return;
    this.placeGizmo(this.model.cadDirToWorld(AXIS_CAD[axis]), offset);
    this.emit();
  }

  setOffset(offset: number): void {
    this.placeGizmo(this.normal(), offset);
    this.emit();
  }

  /** Plane from metadata (CAD frame). Keeps the side the normal points to. */
  setFromMeta(p: PlaneMeta): void {
    if (!this.model) return;
    const n = this.model.cadDirToWorld(p.normal);
    const point = this.model.cadPointToWorld(p.point);
    this.axis = matchAxis(p.normal);
    this.placeGizmo(n, n.dot(point.clone().sub(this.center)));
    this.emit();
  }

  /** Slider range: +/- half the model extent along the current normal. */
  offsetRange(): number {
    if (!this.model) return 1;
    const n = this.normal();
    const box = this.model.worldBox();
    let r = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z])
      r = Math.max(r, Math.abs(n.dot(new THREE.Vector3(x, y, z).sub(this.center))));
    return r;
  }

  /** World normal (gizmo +Z). */
  normal(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1).applyQuaternion(this.gizmo.quaternion).normalize();
  }

  /** True if a world point is on the rendered (kept) side, or if sectioning is off. */
  keeps(p: THREE.Vector3, eps = 1e-6): boolean {
    return !this.enabled || this.plane.distanceToPoint(p) >= -eps;
  }

  private placeGizmo(n: THREE.Vector3, offset: number): void {
    this.offset = offset;
    this.gizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.clone().normalize());
    this.gizmo.position.copy(this.center).addScaledVector(n, offset);
    this.update();
  }

  private applyEnabled(): void {
    const planes = this.enabled ? [this.plane] : [];
    for (const l of this.model?.layers ?? []) {
      l.material.clippingPlanes = planes;
      l.material.needsUpdate = true;
    }
    for (const c of this.caps) {
      const show = this.enabled && c.layer.visible;
      c.back.visible = c.front.visible = c.cap.visible = show;
    }
    this.viewer.invalidate();
  }

  /** Called when layer visibility changes. */
  syncVisibility(): void {
    this.applyEnabled();
  }

  private update(): void {
    this.gizmo.updateMatrixWorld();
    const n = this.normal();
    this.plane.setFromNormalAndCoplanarPoint(n, this.gizmo.position);
    // cap quads lie on the plane, facing the kept side's opposite (the viewer)
    for (const c of this.caps) {
      c.cap.position.copy(this.gizmo.position);
      c.cap.quaternion.copy(this.gizmo.quaternion);
      c.cap.visible = this.enabled && c.layer.visible;
      c.back.visible = c.front.visible = c.cap.visible;
    }
  }
}

function stencilMesh(geometry: THREE.BufferGeometry, side: THREE.Side, op: THREE.StencilOp, plane: THREE.Plane) {
  const mat = new THREE.MeshBasicMaterial({
    side,
    clippingPlanes: [plane],
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: op,
    stencilZFail: op,
    stencilZPass: op,
  });
  const m = new THREE.Mesh(geometry, mat);
  m.raycast = () => {};
  m.matrixAutoUpdate = false;                   // identity w.r.t. the layer mesh
  return m;
}

function matchAxis(n: [number, number, number]): Axis {
  for (const [axis, v] of Object.entries(AXIS_CAD) as [Axis, number[]][])
    if (Math.abs(Math.abs(n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) - 1) < 1e-6) return axis;
  return "custom";
}
