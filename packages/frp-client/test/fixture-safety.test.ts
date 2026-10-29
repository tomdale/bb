import { afterEach, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  fetch: vi.fn(),
  install: vi.fn(),
  spawn: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock("../src/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/binary.js")>()),
  fetchArchive: effects.fetch,
  installFrp: effects.install,
}));

vi.mock("@bb/process-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bb/process-utils")>()),
  spawnHostProcess: effects.spawn,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: effects.read,
  writeFile: effects.write,
  mkdir: effects.mkdir,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it.each([undefined, "", "0", "true", "false", "invalid"])(
  "blocks FRP fixture effects without explicit opt-in: %s",
  async (value) => {
    vi.stubEnv("BB_RUN_REAL_FRP_TESTS", value);
    const fixture = await import("../src/testing/frp-fixture.js");
    expect(fixture.REAL_FRP_TESTS_ENABLED).toBe(false);
    await expect(fixture.installTestFrp("/unused/bin")).rejects.toThrow(
      /BB_RUN_REAL_FRP_TESTS=1/,
    );
    await expect(
      fixture.cachedDownload(process.platform, process.arch)("unused"),
    ).rejects.toThrow(/BB_RUN_REAL_FRP_TESTS=1/);
    await expect(
      fixture.startFrps("/unused/frps", "/unused", 1),
    ).rejects.toThrow(/BB_RUN_REAL_FRP_TESTS=1/);
    for (const effect of Object.values(effects)) {
      expect(effect).not.toHaveBeenCalled();
    }
  },
);

it("recognizes explicit opt-in without executing a fixture", async () => {
  vi.stubEnv("BB_RUN_REAL_FRP_TESTS", "1");
  const fixture = await import("../src/testing/frp-fixture.js");
  expect(fixture.REAL_FRP_TESTS_ENABLED).toBe(true);
  for (const effect of Object.values(effects)) {
    expect(effect).not.toHaveBeenCalled();
  }
});
