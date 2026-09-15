import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig(({ mode }) => ({
  plugins: [preact(), ...(mode === "native" ? [{
    name: "native-bundle",
    transformIndexHtml(html: string) {
      return html.replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>',
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`);
    },
  }] : [])],
  base: mode === "native" ? "./" : "/",
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  build: {
    outDir: mode === "native" ? "../../ios/Agent/Panel" : "dist",
    emptyOutDir: true,
    target: "es2019",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
}));
