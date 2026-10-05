import { afterEach, expect, it, vi } from "vitest";
import { buildPiChildEnv } from "./rpc-child.js";

afterEach(() => vi.unstubAllEnvs());

it("uses only the current session tools file while preserving provider credentials", () => {
  vi.stubEnv("PI_BB_TOOLS_FILE", "/previous-session/tools.json");
  vi.stubEnv("OPENAI_API_KEY", "test-provider-key");

  const catalogEnv = buildPiChildEnv({});
  expect(catalogEnv.PI_BB_TOOLS_FILE).toBeUndefined();
  expect(catalogEnv.OPENAI_API_KEY).toBe("test-provider-key");

  const sessionEnv = buildPiChildEnv({
    PI_BB_TOOLS_FILE: "/current-session/tools.json",
  });
  expect(sessionEnv.PI_BB_TOOLS_FILE).toBe("/current-session/tools.json");
  expect(process.env.PI_BB_TOOLS_FILE).toBe("/previous-session/tools.json");
});
