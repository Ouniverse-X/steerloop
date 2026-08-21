import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.STEERLOOP_WEB_HOST ?? "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: process.env.STEERLOOP_WEB_HOST ?? "127.0.0.1",
    port: 4173,
  },
});
