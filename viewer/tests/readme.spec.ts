import { test, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {} from "../src/main";

// README images (.github/images/): the full UI in the default dark theme
const outDir = fileURLToPath(new URL("../../.github/images/", import.meta.url));
mkdirSync(outDir, { recursive: true });

const SHOTS: [string, string][] = [
  ["axial_inductor", "component=axial_inductor_l11&preset=exterior&physics=play"],
  ["carbon_film_resistor", "component=carbon_film_resistor_0204&preset=exterior&physics=play"],
];

async function open(page: Page, query: string) {
  await page.goto(`./?${query}&variant=exaggerated&theme=dark&instant=1`);
  await page.waitForFunction(() => window.__ready === true);
}

/** Render two fresh frames with animation time frozen. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const v = window.__app!.viewer;
    v.timeScale = 0;
    const start = v.frameCount;
    const tick = () => {
      if (v.frameCount > start + 1) return resolve();
      v.invalidate();
      requestAnimationFrame(tick);
    };
    tick();
  }));
}

async function capture(page: Page, name: string, query: string) {
  await open(page, query);
  await settle(page);
  await page.screenshot({ path: `${outDir}${name}.png` });
}

for (const [name, query] of SHOTS) test(`readme image: ${name}`, async ({ page }) => capture(page, name, query));

// MLCC in AC: one full cycle, one frame per 10 degrees of phase (loops seamlessly). Frames go to
// .test-output/gif/; tests/make_gif.py turns them into .github/images/mlcc_ac.gif.
test("readme gif frames: mlcc_ac", async ({ page }) => {
  const frames = fileURLToPath(new URL("../../.test-output/gif/", import.meta.url));
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  await open(page, "component=mlcc_0603&preset=exterior&physics=1");
  await page.evaluate(() => {
    const cap = window.__app!.capPhysics;
    cap.setAc(true);
    cap.state.paused = true;
    window.__app!.reframePhysics();
  });
  const vp = (await page.locator("#viewport").boundingBox())!;
  const hud = (await page.locator("#physics-hud").boundingBox())!;
  const clip = { x: vp.x, y: vp.y, width: vp.width, height: hud.y - vp.y - 4 };
  for (let i = 0; i < 36; i++) {
    await page.evaluate((ph) => window.__app!.capPhysics.set("phaseDeg", ph), i * 10);
    await settle(page);
    await page.screenshot({ path: `${frames}${String(i).padStart(2, "0")}.png`, clip });
  }
});
