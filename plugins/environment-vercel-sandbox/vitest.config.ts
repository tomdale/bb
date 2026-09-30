import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";
export default defineWorkspaceTestConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "bb-plugin-environment-vercel-sandbox",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["dist/**", "node_modules/**"],
    }),
  },
});
