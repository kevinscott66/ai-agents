import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    proxy: { "/office/": { target: "http://127.0.0.1:4318", ws: true } },
  },
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1100 },
});
