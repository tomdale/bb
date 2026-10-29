import { afterEach, expect, it, vi } from "vitest";
import { frpBinaries } from "./frp-binaries.js";

const effects = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: effects.access,
  mkdir: effects.mkdir,
}));

vi.mock("node:child_process", () => ({ execFile: effects.exec }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([undefined, "", "0", "true", "false", "invalid"])(
  "skips FRP before touching cached binaries or the network: %s",
  async (value) => {
    vi.stubEnv("BB_RUN_REAL_FRP_TESTS", value);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(frpBinaries()).resolves.toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
    for (const effect of Object.values(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  },
);
