import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLabRuntimeConfig,
  createExpectedLabRuntimeConfig,
  parseExpectedLabRuntimeConfig,
} from "../scripts/lab-runtime-config.mjs";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHomeDirectory() {
  const homeDir = await mkdtemp(join(tmpdir(), "bb-lab-config-"));
  tempDirectories.push(homeDir);
  return homeDir;
}

describe("Lab expected runtime configuration", () => {
  it("places absent-override defaults under home rather than the working directory", async () => {
    const homeDir = await createHomeDirectory();
    expect(createExpectedLabRuntimeConfig({ env: {}, homeDir })).toMatchObject({
      dataDir: join(homeDir, ".bb-lab"),
      appDataDir: join(homeDir, ".bb-lab-electron"),
      userDataDir: join(homeDir, ".bb-lab-desktop"),
      serverPort: "38890",
      daemonPort: "38891",
    });
  });
  it("normalizes relative and tilde overrides without creating paths", async () => {
    const homeDir = await createHomeDirectory();
    const relativeDataDir = relative(process.cwd(), join(homeDir, "lab-data"));
    const tildeAppData = `~/${relative(homeDir, join(homeDir, "lab-app"))}`;
    const expected = createExpectedLabRuntimeConfig({
      env: {
        BB_LAB_DATA_DIR: relativeDataDir,
        BB_LAB_APP_DATA_DIR: tildeAppData,
        BB_LAB_USER_DATA_DIR: "~/lab-user",
        BB_LAB_SERVER_PORT: "39022",
        BB_LAB_HOST_DAEMON_PORT: "39023",
      },
      homeDir,
    });

    expect(expected).toMatchObject({
      dataDir: join(homeDir, "lab-data"),
      appDataDir: join(homeDir, "lab-app"),
      userDataDir: join(homeDir, "lab-user"),
      serverPort: "39022",
      daemonPort: "39023",
    });
    await expect(
      import("node:fs/promises").then(({ access }) => access(expected.dataDir)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["relative prefix", "relative"],
    ["tilde prefix", "tilde"],
  ])("rejects symlinked daily-data prefix for %s override", async (kind) => {
    const homeDir = await createHomeDirectory();
    const realDailyDir = join(homeDir, "daily-data");
    await mkdir(realDailyDir);
    await symlink(realDailyDir, join(homeDir, ".bb"));
    const target = join(homeDir, ".bb", "missing", "nested");
    const override =
      kind === "relative prefix"
        ? relative(process.cwd(), target)
        : `~/${relative(homeDir, target)}`;

    expect(() =>
      createExpectedLabRuntimeConfig({
        env: { BB_LAB_DATA_DIR: override },
        homeDir,
      }),
    ).toThrow("must not alias the normal ~/.bb directory");
  });

  it("parses a separately serialized smoke target independent of Lab overrides", () => {
    const serializedExpected = JSON.stringify({
      dataDir: "/tmp/lab/data",
      appDataDir: "/tmp/lab/app-data",
      userDataDir: "/tmp/lab/user-data",
      bindHost: "127.0.0.1",
      serverPort: "39132",
      daemonPort: "39133",
    });
    const independentlyExpected = parseExpectedLabRuntimeConfig({
      serializedExpected,
      homeDir: "/tmp/lab-home",
    });
    const omittedLabInputs = {};
    const profileDefaults = createExpectedLabRuntimeConfig({
      env: omittedLabInputs,
      homeDir: "/tmp/lab",
    });
    const resolvedFromOmittedInputs = {
      BB_DATA_DIR: profileDefaults.dataDir,
      BB_DESKTOP_APP_DATA_DIR: profileDefaults.appDataDir,
      BB_DESKTOP_USER_DATA_DIR: profileDefaults.userDataDir,
      BB_SERVER_BIND_HOST: profileDefaults.bindHost,
      BB_SERVER_PORT: profileDefaults.serverPort,
      BB_HOST_DAEMON_PORT: profileDefaults.daemonPort,
    };

    expect(() =>
      assertLabRuntimeConfig(resolvedFromOmittedInputs, independentlyExpected),
    ).toThrow("did not match its expected isolated target");
  });

  it("fails closed before filesystem writes when resolved config drifts", async () => {
    const homeDir = await createHomeDirectory();
    const expected = createExpectedLabRuntimeConfig({
      env: {
        BB_LAB_DATA_DIR: join(homeDir, "owned", ".bb-lab"),
        BB_LAB_APP_DATA_DIR: join(homeDir, "owned", "app-data"),
        BB_LAB_USER_DATA_DIR: join(homeDir, "owned", "user-data"),
        BB_LAB_SERVER_PORT: "39122",
        BB_LAB_HOST_DAEMON_PORT: "39123",
      },
      homeDir,
    });
    const resolved = {
      BB_DATA_DIR: expected.dataDir,
      BB_DESKTOP_APP_DATA_DIR: expected.appDataDir,
      BB_DESKTOP_USER_DATA_DIR: expected.userDataDir,
      BB_SERVER_BIND_HOST: expected.bindHost,
      BB_SERVER_PORT: expected.serverPort,
      BB_HOST_DAEMON_PORT: expected.daemonPort,
    };

    expect(() => assertLabRuntimeConfig(resolved, expected)).not.toThrow();
    expect(() =>
      assertLabRuntimeConfig(
        { ...resolved, BB_DATA_DIR: join(homeDir, ".bb") },
        expected,
      ),
    ).toThrow("did not match its expected isolated target");
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(join(homeDir, "owned")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
