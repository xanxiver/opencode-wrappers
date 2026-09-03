import { defineConfig } from "@pandacss/dev"
import { createPreset } from "@park-ui/panda-preset"
import accentColor from "@park-ui/panda-preset/colors/brown"
import grayColor from "@park-ui/panda-preset/colors/sand"

export default defineConfig({
  presets: [createPreset({ accentColor, grayColor, radius: "md" })],
  preflight: true,
  include: ["./src/web/**/*.{ts,tsx}"],
  outdir: "src/web/styled-system",
  jsxFramework: "solid",
  globalCss: {
    extend: {
      html: { colorPalette: "brown" },
      body: {
        background: "var(--coffee-canvas)",
        backgroundImage: "radial-gradient(circle at 18% 8%, var(--coffee-glow), transparent 30%)",
      },
    },
  },
  staticCss: { recipes: "*" },
})
