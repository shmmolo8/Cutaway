import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ComponentMeta, IndexEntry } from "./types";

const BASE = import.meta.env.BASE_URL;

export async function loadIndex(): Promise<IndexEntry[]> {
  const res = await fetch(`${BASE}index.json`);
  if (!res.ok) throw new Error(`index.json: ${res.status} (run \`make export\`)`);
  return (await res.json()).components;
}

export interface LoadedVariant {
  meta: ComponentMeta;
  scene: THREE.Group;
}

const loader = new GLTFLoader();

export async function loadVariant(stem: string): Promise<LoadedVariant> {
  const [meta, gltf] = await Promise.all([
    fetch(`${BASE}${stem}.json`).then((r) => {
      if (!r.ok) throw new Error(`${stem}.json: ${r.status}`);
      return r.json() as Promise<ComponentMeta>;
    }),
    loader.loadAsync(`${BASE}${stem}.glb`),
  ]);
  if (meta.schema_version !== 1) throw new Error(`unsupported schema ${meta.schema_version}`);
  return { meta, scene: gltf.scene };
}
