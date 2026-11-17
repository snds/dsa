import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Low-fidelity layouts for the redesign proposal (docs/redesign). Built from the dashboard's own UI kit
// (src/components/ui) so the screens use the real components, tokens and type. Not part of the app:
// nothing in src imports this, and the app's build ignores it.
//   npx vite build --config wireframes/vite.config.ts      (from packages/dashboard/ui)
/** One self-contained HTML file: the script and stylesheet inlined, so it opens from disk or any host. */
const oneFile = {
  name: "one-file",
  enforce: "post" as const,
  generateBundle(_: unknown, bundle: Record<string, any>) {
    const html = bundle["index.html"], js = bundle["app.js"], css = bundle["app.css"]
    if (!html || !js || !css) return
    const code = String(js.code).replace(/<\/script/gi, "<\\/script")
    html.source = String(html.source)
      .replace(/<script[^>]*src="\.\/app\.js"[^>]*><\/script>/, "")
      .replace(/<link[^>]*href="\.\/app\.css"[^>]*>/, () => `<style>${css.source}</style>`)
      .replace("</body>", () => `<script>${code}</script></body>`)
    delete bundle["app.js"]; delete bundle["app.css"]
  },
}

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), tailwindcss(), oneFile],
  resolve: { alias: { "@": resolve(import.meta.dirname, "../src") } },
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, "../../../../docs/redesign/wireframes"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: { output: { entryFileNames: "app.js", assetFileNames: "app[extname]", format: "iife" } },
  },
})
