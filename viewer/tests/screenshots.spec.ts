import { expect, test, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import type {} from "../src/main";
import { fileURLToPath } from "node:url";

/**
 * Screenshot every preset of every component variant listed in build/index.json.
 * Output: .test-output/screenshots/<component>/<variant>/<preset>.png
 * Set COMPONENTS=chip_resistor_0603,mlcc_0603 to limit (default: all).
 */
const buildDir = fileURLToPath(new URL("../../build/", import.meta.url));
const shotDir = fileURLToPath(new URL("../../.test-output/screenshots/", import.meta.url));
const index = JSON.parse(readFileSync(`${buildDir}index.json`, "utf8")).components as {
  id: string; variants: Record<string, string>;
}[];
const filter = process.env.COMPONENTS ?? "all";
const components = filter === "all" ? index : index.filter((c) => filter.split(",").includes(c.id));

async function ready(page: Page) {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  // rendering is on demand: wait until a frame has been drawn after setup
  await page.evaluate(() => new Promise<void>((resolve) => {
    const start = window.__app!.viewer.frameCount;
    window.__app!.viewer.invalidate();
    const tick = () => (window.__app!.viewer.frameCount > start ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }));
  const err = await page.locator(".status.error").count();
  expect(err, "viewer reported an error").toBe(0);
}

for (const comp of components) {
  for (const [variant, stem] of Object.entries(comp.variants)) {
    const meta = JSON.parse(readFileSync(`${buildDir}${stem}.json`, "utf8"));
    for (const preset of meta.presets as { id: string }[]) {
      test(`${comp.id} ${variant} ${preset.id}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(`./?component=${comp.id}&variant=${variant}&preset=${preset.id}&instant=1`);
        await ready(page);
        const dir = `${shotDir}${comp.id}/${variant}`;
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: `${dir}/${preset.id}.png` });
        expect(errors).toEqual([]);
      });
    }
  }
}
