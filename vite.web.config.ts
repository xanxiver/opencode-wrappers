import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiPort = env.WEB_PORT || "3001"
  const uiPort = Number(env.WEB_UI_PORT || "3000")
  return {
  plugins: [solid()],
  root: "src/web",
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "esnext" },
  server: {
    port: uiPort,
    proxy: {
      "/api": `http://localhost:${apiPort}`,
    },
  },
  }
})
