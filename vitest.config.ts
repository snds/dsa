import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Add-ons import the core and each other by name; tests run them against the source.
    alias: [
      { find: /^@snds\/dsa$/, replacement: at("./src/index.ts") },
      { find: /^@snds\/dsa\/engine$/, replacement: at("./src/engine/index.ts") },
      ...["review", "dashboard", "figma", "agent", "history"].map((n) => ({ find: new RegExp(`^@snds/dsa-${n}$`), replacement: at(`./packages/${n}/src/index.ts`) })),
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
