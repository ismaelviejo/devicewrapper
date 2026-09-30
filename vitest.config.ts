import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const alias = {
  "@devicewrapper/schema": pkg("schema"),
  "@devicewrapper/core": pkg("core"),
  "@devicewrapper/renderer": pkg("renderer"),
  "@devicewrapper/jobs": pkg("jobs"),
  "@devicewrapper/mcp": pkg("mcp"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], testTimeout: 20000 },
      },
      {
        resolve: { alias },
        test: { name: "golden", include: ["tests/golden/**/*.test.ts"], testTimeout: 180000, hookTimeout: 120000, fileParallelism: false },
      },
    ],
  },
});
