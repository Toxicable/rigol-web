import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    allowedHosts: ["rigol-web.fabianserver.xyz"],
    proxy: {
      "/ws": {
        target: "http://localhost:3000",
        ws: true,
      },
      "/health": {
        target: "http://localhost:3000",
      },
    },
  },
});
