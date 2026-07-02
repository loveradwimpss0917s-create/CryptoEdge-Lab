import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// docs/01 §6: builds to dist/, served by the api Worker's Static Assets
// binding (apps/api/wrangler.jsonc assets.directory = "../web/dist").
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787" // wrangler dev for apps/api, docs/01 §5
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
