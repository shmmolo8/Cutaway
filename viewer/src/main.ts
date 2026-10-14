import * as THREE from "three";
import { App } from "./app";

declare global {
  interface Window {
    __app?: App;
    __ready?: boolean;
    /** three namespace for debugging and test scripts */
    THREE_NS?: typeof THREE;
  }
}

const app = new App();
window.__app = app;
window.THREE_NS = THREE;
app.start()
  .then(() => { window.__ready = true; })
  .catch((err: unknown) => {
    console.error(err);
    app.status(String(err instanceof Error ? err.message : err), true);
  });
