import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

// The Python pipeline writes index.json + models/*.{glb,json} into ../build.
const buildDir = fileURLToPath(new URL("../build", import.meta.url));
const TYPES: Record<string, string> = { ".json": "application/json", ".glb": "model/gltf-binary" };

/**
 * Serve ../build at the site root, resolved per request (so `make clean`/re-export never
 * breaks a running dev server), and copy only what the viewer loads into production builds.
 */
function buildData(): Plugin {
  let outDir = "dist";
  return {
    name: "cutaway-build-data",
    configResolved(c) { outDir = c.build.outDir; },
    configureServer(server) {
      server.watcher.add(join(buildDir, "index.json"));
      server.middlewares.use((req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? "").split("?")[0])).replace(/^([/\\])+/, "");
        const file = join(buildDir, path);
        const type = TYPES[extname(file)];
        if (!type || !file.startsWith(buildDir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const copy = (rel: string) => {
        mkdirSync(join(outDir, rel, ".."), { recursive: true });
        copyFileSync(join(buildDir, rel), join(outDir, rel));
      };
      if (!existsSync(join(buildDir, "index.json"))) throw new Error("build/index.json missing: run `make export`");
      copy("index.json");
      for (const f of readdirSync(join(buildDir, "models")))
        if (f.endsWith(".glb") || f.endsWith(".json")) copy(join("models", f));
    },
  };
}

export default defineConfig({
  base: "./",
  publicDir: false,
  plugins: [buildData()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
