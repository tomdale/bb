import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sdkSource = (path: string) =>
  fileURLToPath(
    new URL(`../../packages/plugin-sdk/src/${path}`, import.meta.url),
  );

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: "@get-bb/plugin-sdk/testing/app",
        replacement: sdkSource("testing/app.tsx"),
      },
      {
        find: "@get-bb/plugin-sdk/testing",
        replacement: sdkSource("testing/index.ts"),
      },
      { find: "@get-bb/plugin-sdk/app", replacement: sdkSource("app.ts") },
      { find: "@get-bb/plugin-sdk", replacement: sdkSource("index.ts") },
    ],
  },
  test: {
    silent: "passed-only",
    name: "bb-plugin-tts",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
