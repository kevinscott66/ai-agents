import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8790",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
