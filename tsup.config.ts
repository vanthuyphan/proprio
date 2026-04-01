import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "sdk/middleware": "src/sdk/middleware.ts",
      "bin/meta-harness": "bin/meta-harness.ts",
    },
    format: ["cjs", "esm"],
    dts: false,
    splitting: false,
    clean: true,
    external: ["@anthropic-ai/sdk"],
  },
]);
