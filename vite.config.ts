import { defineConfig } from "vite";

export default defineConfig({
  root: "src/ui",
  base: "./",
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "esnext",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 20000,
  },
  worker: { format: "es" },
});
