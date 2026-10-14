import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173/",
    viewport: { width: 1400, height: 860 },
    deviceScaleFactor: 1,
    launchOptions: {
      // software WebGL (with stencil) so screenshots work headless / without a GPU
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: "npx vite --port 5173 --strictPort",
    url: "http://localhost:5173/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
