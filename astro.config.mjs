import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [react()],
  output: "static",
  devToolbar: { enabled: false },
  server: { port: 4321, host: "127.0.0.1" },
  vite: {
    plugins: [tailwindcss()],
    server: {
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:9780",
          changeOrigin: true,
          ws: true,
        },
      },
    },
  },
});
