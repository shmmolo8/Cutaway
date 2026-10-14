import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {} from "../src/main";

/** Interaction scenarios beyond the metadata presets. Output: .test-output/screenshots/scenarios/ */
const outDir = fileURLToPath(new URL("../../.test-output/screenshots/scenarios/", import.meta.url));
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`./?${query}&instant=1`);
  await page.waitForFunction(() => window.__ready === true);
  return errors;
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const v = window.__app!.viewer;
    const start = v.frameCount;
    v.invalidate();
    const tick = () => (v.frameCount > start ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  await page.screenshot({ path: `${outDir}${name}.png` });
}

/** NDC of a CAD-frame point for the current camera. */
async function ndcOf(page: Page, cad: [number, number, number]) {
  return page.evaluate((p) => {
    const app = window.__app!;
    const v = app.model!.cadPointToWorld(p).project(app.viewer.camera);
    return [v.x, v.y] as [number, number];
  }, cad);
}

test("picking: caps are pickable, clipped side is ignored", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=longitudinal");
  const lv = await page.evaluate(() => window.__app!.model!.meta.component.levels);
  // centre of the substrate on the cut plane (y = 0) -> substrate cap
  const zSub = (lv.substrate_bottom + lv.substrate_top) / 2;
  const [x1, y1] = await ndcOf(page, [0, 0, zSub]);
  const hit = await page.evaluate(([x, y]) => {
    const app = window.__app!;
    const THREE = window.THREE_NS!;
    return app.pickAt(new THREE.Vector2(x, y));
  }, [x1, y1]);
  expect(hit).toBe("substrate");

  // a point on the overcoat top in the removed half (y < 0): the first raw hit is on
  // the clipped side and must be skipped
  const [x2, y2] = await ndcOf(page, [0.2, -0.25, lv.overcoat_top]);
  const r = await page.evaluate(([x, y]) => {
    const app = window.__app!;
    const THREE = window.THREE_NS!;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(x, y), app.viewer.camera);
    const raw = rc.intersectObjects(app.model!.layers.map((l) => l.mesh), false)[0];
    const rawSide = app.section.plane.distanceToPoint(raw.point);
    const picked = app.pickDetail(new THREE.Vector2(x, y));
    return { rawSide, picked };
  }, [x2, y2]);
  expect(r.rawSide).toBeLessThan(0);          // raw raycast hits the clipped-away part
  expect(r.picked).not.toBeNull();
  expect(r.picked!.planeDistance).toBeGreaterThanOrEqual(-1e-5);   // pick is on the kept side
  expect(errors).toEqual([]);
});

test("exploded view with active slice plane", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=longitudinal");
  await page.evaluate(() => {
    const app = window.__app!;
    app.animateExplode(1, false);
    const m = app.model!;
    app.viewer.frameBox(m.boxAtExplode(1), m.cadDirToWorld([0.35, -1, 0.45]), {});
  });
  await shot(page, "exploded_with_section");
  expect(errors).toEqual([]);
});

test("half-exploded (stagger) with section", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=longitudinal");
  await page.evaluate(() => {
    const app = window.__app!;
    app.setExplode(0.5);
    const m = app.model!;
    app.viewer.frameBox(m.boxAtExplode(1), m.cadDirToWorld([0, -1, 0.15]), {});
  });
  await shot(page, "half_exploded_section");
  expect(errors).toEqual([]);
});

test("isolate resistive layer + info card", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=exterior");
  await page.locator('.layer-row[data-layer="resistive"] .isolate').click();
  await page.locator('.layer-row[data-layer="resistive"]').click();
  await page.mouse.move(700, 120);                 // leave the row: selection only, no hover
  await expect(page.locator("#info")).toBeVisible();
  await expect(page.locator("#info h3")).toContainText("Resistive element");
  const visible = await page.evaluate(() => window.__app!.model!.layers.filter((l) => l.visible).map((l) => l.meta.id));
  expect(visible).toEqual(["resistive"]);
  await page.evaluate(() => {
    const app = window.__app!;
    const m = app.model!;
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0.25, -0.6, 1]), {});
  });
  await shot(page, "isolate_resistive_info");
  // un-isolate restores everything
  await page.locator('.layer-row[data-layer="resistive"] .isolate').click();
  const [n, total] = await page.evaluate(() => {
    const layers = window.__app!.model!.layers;
    return [layers.filter((l) => l.visible).length, layers.length];
  });
  expect(n).toBe(total);
  expect(errors).toEqual([]);
});

test("click in 3D selects a cap; hover highlights row", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=transverse");
  const lv = await page.evaluate(() => window.__app!.model!.meta.component.levels);
  const box = await page.locator("#viewport canvas").boundingBox();
  // a point inside the top-electrode cap on the transverse plane
  const xPlane = await page.evaluate(() => window.__app!.preset("transverse")!.plane!.point[0]);
  const [nx, ny] = await ndcOf(page, [xPlane, 0.1, (lv.substrate_top + lv.top_electrode_top) / 2]);
  const px = box!.x + (nx + 1) / 2 * box!.width, py = box!.y + (1 - ny) / 2 * box!.height;
  await page.mouse.move(px, py);
  await page.waitForTimeout(150);
  await expect(page.locator('.layer-row[data-layer="top_electrode_R"]')).toHaveClass(/hover/);
  await page.mouse.click(px, py);
  await expect(page.locator("#info h3")).toContainText("Top electrode (R)");
  await page.mouse.move(box!.x + 20, box!.y + 20);   // off the part: selection only
  await expect(page.locator('.layer-row[data-layer="top_electrode_R"]')).not.toHaveClass(/hover/);
  await shot(page, "cap_selected_transverse");
  expect(errors).toEqual([]);
});

test("scale toggle keeps camera, plane, explode and selection", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=longitudinal");
  await page.evaluate(() => {
    const app = window.__app!;
    app.setExplode(0.4);
    app.select("resistive");
  });
  const before = await page.evaluate(() => {
    const a = window.__app!;
    return { cam: a.viewer.camera.position.toArray(), plane: [...a.section.plane.normal.toArray(), a.section.plane.constant] };
  });
  await page.getByRole("combobox", { name: "Scale" }).selectOption({ label: "True scale" });
  await expect(page.locator("#variant-badge")).toHaveText("True scale");
  const after = await page.evaluate(() => {
    const a = window.__app!;
    return {
      cam: a.viewer.camera.position.toArray(), plane: [...a.section.plane.normal.toArray(), a.section.plane.constant],
      explode: a.model!.explode, selected: a.selected, sectionOn: a.section.enabled, variant: a.model!.meta.component.variant,
    };
  });
  expect(after.variant).toBe("true_scale");
  expect(after.explode).toBeCloseTo(0.4);
  expect(after.selected).toBe("resistive");
  expect(after.sectionOn).toBe(true);
  after.cam.forEach((v, i) => expect(v).toBeCloseTo(before.cam[i], 6));
  after.plane.forEach((v, i) => expect(v).toBeCloseTo(before.plane[i], 6));
  await expect(page.locator("#info")).toContainText("Resistive element");
  await page.mouse.move(700, 120);
  await shot(page, "scale_toggle_true_scale_kept_state");
  expect(errors).toEqual([]);
});

test("phone-width layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=longitudinal");
  await expect(page.getByRole("button", { name: /Controls/ })).toHaveAttribute("aria-expanded", "false");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await shot(page, "mobile_longitudinal");
  expect(errors).toEqual([]);
});

test("exterior shows printed marking", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=exterior");
  const ids = await page.evaluate(() => window.__app!.model!.layers.map((l) => l.meta.id));
  expect(ids).toContain("marking");
  await page.evaluate(() => {
    const app = window.__app!;
    const m = app.model!;
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0.25, -0.9, 1.3]), {});
  });
  await shot(page, "exterior_marking");
  expect(errors).toEqual([]);
});

test("component menu switches parts in one viewer", async ({ page }) => {
  const errors = await open(page, "component=chip_resistor_0603&variant=exaggerated&preset=exterior");
  await page.locator("#menu-btn").click();
  await expect(page.locator("#menu")).toBeVisible();
  await shot(page, "menu_open");
  await page.locator('.menu-item[data-component="mlcc_0603"]').click();
  await expect(page.locator("#title")).toHaveText("Ceramic chip capacitor (MLCC)");
  await expect(page.locator("#menu")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("component")).toBe("mlcc_0603");
  const ids = await page.evaluate(() => window.__app!.model!.layers.map((l) => l.meta.id));
  expect(ids).toContain("inner_electrodes_L");
  await expect(page.locator(".layer-row")).toHaveCount(ids.length);
  expect(errors).toEqual([]);
});

test("light theme toggle", async ({ page }) => {
  const errors = await open(page, "component=mlcc_0603&variant=exaggerated&preset=longitudinal&theme=light");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  const bgLight = await page.evaluate(() => (window.__app!.viewer.scene.background as { getHexString(): string }).getHexString());
  await shot(page, "light_mlcc_longitudinal");
  await page.locator("#theme-btn").click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  const bgDark = await page.evaluate(() => (window.__app!.viewer.scene.background as { getHexString(): string }).getHexString());
  expect(bgDark).not.toBe(bgLight);
  expect(errors).toEqual([]);
});
