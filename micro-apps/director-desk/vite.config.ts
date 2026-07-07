import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/director-desk/",
  build: {
    outDir: "../../public/director-desk",
    emptyOutDir: true,
  },
  assetsInclude: ["**/*.fbx", "**/*.obj"],
  plugins: [react()],
  server: {
    fs: {
      allow: [
        decodeURIComponent(new URL(".", import.meta.url).pathname),
        decodeURIComponent(new URL("../模型库", import.meta.url).pathname),
      ],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    maxWorkers: 1,
    setupFiles: "./src/test/setup.ts",
  },
});
