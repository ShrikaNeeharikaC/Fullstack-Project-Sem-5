import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page app: each .html page is its own React entry, so the existing URLs
// (dashboard.html?url=..., login.html?next=...) keep working unchanged.
const pages = ["index", "login", "signup", "scan", "dashboard"];

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
});
