import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopApplicationIdentity,
  createDesktopProfileEnvironment,
} from "../src/desktop-build-profile.js";
import { createExpectedLabRuntimeConfig } from "../scripts/lab-runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createHomeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-desktop-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("desktop build profiles", () => {
  it.each([
    ["personal", "com.tomdale.bb.personal", "bb Personal", "icon-personal.png"],
    ["lab", "com.tomdale.bb.lab", "bb Lab", "icon-lab.png"],
  ] as const)(
    "uses the private %s identity",
    (profile, appId, applicationName, iconFileName) => {
      expect(createDesktopApplicationIdentity(profile, "latest")).toMatchObject(
        {
          appId,
          applicationName,
          iconFileName,
          updatesEnabled: false,
        },
      );
    },
  );

  it("preserves the upstream release identities", () => {
    expect(createDesktopApplicationIdentity("release", "latest")).toMatchObject(
      {
        appId: "dev.bb.desktop",
        applicationName: "bb",
        iconFileName: "icon.png",
        updatesEnabled: true,
      },
    );
    expect(
      createDesktopApplicationIdentity("release", "nightly"),
    ).toMatchObject({
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      iconFileName: "icon-nightly.png",
      updatesEnabled: true,
    });
  });

  it("forces Lab onto its own local runtime despite hostile inherited settings", async () => {
    const homeDir = await createHomeDirectory();
    const env = createDesktopProfileEnvironment({
      env: {
        BB_APP_URL: "https://daily.example.test",
        BB_DATA_DIR: join(homeDir, ".bb"),
        BB_DESKTOP_APP_URL: "https://daily.example.test/app",
        BB_DESKTOP_USER_DATA_DIR: join(homeDir, ".bb", "electron"),
        BB_EXTERNAL_URL: "https://daily.example.test",
        BB_HOST_DAEMON_PORT: "38887",
        BB_SERVER_BIND_HOST: "0.0.0.0",
        BB_SERVER_PORT: "38886",
        BB_SERVER_URL: "http://127.0.0.1:38886",
        BB_WORKTREE_POLICY: "daily",
        BB_PERSONAL_USER_DATA_DIR: "/synthetic/daily/personal-user",
        BB_PERSONAL_APP_DATA_DIR: "/synthetic/daily/personal-app",
        BB_LAB_DATA_DIR: "/synthetic/daily/lab-data",
        BB_LAB_USER_DATA_DIR: "/synthetic/daily/lab-user",
        BB_LAB_APP_DATA_DIR: "/synthetic/daily/lab-app",
        BB_LAB_SERVER_PORT: "38892",
        BB_LAB_HOST_DAEMON_PORT: "38893",
        BB_CLI: "/synthetic/daily/bin/bb",
        BB_CLI_DIR: "/synthetic/daily/daemon",
        BB_CLI_REEXEC: "1",
        BB_CONNECT_MACHINE_CREDENTIAL: "synthetic-daily-credential",
        BB_CONNECT_MACHINE_ID: "synthetic-daily-machine",
        BB_HOST_ENROLL_KEY: "synthetic-daily-enroll-key",
        BB_HOST_ID: "synthetic-daily-host",
        BB_HOST_NAME: "synthetic-daily-name",
        BB_INHERITED_SKILLS_ROOTS: "/synthetic/daily/skills",
        BB_SERVER_HEADERS: '{"authorization":"synthetic-daily-header"}',
        BB_APP_SURFACE: "web",
        BB_HOST_DAEMON_AUTO_UPDATE: "1",
        BB_HOST_DAEMON_SUPERVISED: "1",
        BB_APP_UPDATE_MODE: "app",
        BB_POSTHOG_API_KEY: "synthetic-daily-telemetry-key",
        BB_INFERENCE: "synthetic-daily-inference",
        BB_INFERENCE_FALLBACK: "synthetic-daily-fallback",
        BB_TRANSCRIPTION: "synthetic-daily-transcription",
        BB_TELEMETRY: "true",
        BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD: "1",
        BB_APP_NPM_PREFIX: "/synthetic/daily/npm",
        BB_PROVIDER_BRIDGE_RECORD_DIR: "/synthetic/daily/recordings",
        BB_SERVER_LAUNCH_ID: "synthetic-daily-launch",
        BB_APP_VERSION: "99.0.0-daily",
        BB_BRIDGE_DIR: "/synthetic/daily/bridges",
        BB_LOG_LEVEL: "trace",
        BB_MARKETPLACE_URL: "https://daily.example.test/marketplace.json",
        BB_DEV_APP_PORT: "12345",
        BB_FF_PLACEHOLDER: "true",
        BB_FF_TIMELINE_WINDOW_EVENT_BUDGET: "99",
        XDG_CONFIG_HOME: "/synthetic/daily/config",
      },
      homeDir,
      profile: "lab",
    });

    expect(env).toMatchObject({
      BB_DATA_DIR: "/synthetic/daily/lab-data",
      BB_DESKTOP_APP_DATA_DIR: "/synthetic/daily/lab-app",
      BB_DESKTOP_USER_DATA_DIR: "/synthetic/daily/lab-user",
      BB_HOST_DAEMON_PORT: "38893",
      BB_SERVER_BIND_HOST: "127.0.0.1",
      BB_SERVER_PORT: "38892",
      BB_APP_SURFACE: "desktop",
      BB_TELEMETRY: "false",
    });
    for (const key of [
      "BB_APP_URL",
      "BB_DESKTOP_APP_URL",
      "BB_PERSONAL_USER_DATA_DIR",
      "BB_PERSONAL_APP_DATA_DIR",
      "BB_LAB_DATA_DIR",
      "BB_LAB_USER_DATA_DIR",
      "BB_LAB_APP_DATA_DIR",
      "BB_LAB_SERVER_PORT",
      "BB_LAB_HOST_DAEMON_PORT",
      "BB_EXTERNAL_URL",
      "BB_SERVER_URL",
      "BB_WORKTREE_POLICY",
      "BB_CLI",
      "BB_CLI_DIR",
      "BB_CLI_REEXEC",
      "BB_CONNECT_MACHINE_CREDENTIAL",
      "BB_CONNECT_MACHINE_ID",
      "BB_HOST_ENROLL_KEY",
      "BB_HOST_ID",
      "BB_HOST_NAME",
      "BB_INHERITED_SKILLS_ROOTS",
      "BB_SERVER_HEADERS",
      "BB_HOST_DAEMON_AUTO_UPDATE",
      "BB_HOST_DAEMON_SUPERVISED",
      "BB_APP_UPDATE_MODE",
      "BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD",
      "BB_APP_NPM_PREFIX",
      "BB_PROVIDER_BRIDGE_RECORD_DIR",
      "BB_SERVER_LAUNCH_ID",
      "BB_APP_VERSION",
      "BB_BRIDGE_DIR",
      "BB_LOG_LEVEL",
      "BB_MARKETPLACE_URL",
      "BB_DEV_APP_PORT",
      "BB_FF_PLACEHOLDER",
      "BB_FF_TIMELINE_WINDOW_EVENT_BUDGET",
      "BB_POSTHOG_API_KEY",
      "XDG_CONFIG_HOME",
      "BB_INFERENCE",
      "BB_INFERENCE_FALLBACK",
      "BB_TRANSCRIPTION",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("fails closed when a Lab override is dropped before startup writes", async () => {
    const homeDir = await createHomeDirectory();
    const overrides = {
      BB_LAB_DATA_DIR: join(homeDir, "owned", ".bb-lab"),
      BB_LAB_APP_DATA_DIR: join(homeDir, "owned", "app-data"),
      BB_LAB_USER_DATA_DIR: join(homeDir, "owned", "user-data"),
      BB_LAB_SERVER_PORT: "39012",
      BB_LAB_HOST_DAEMON_PORT: "39013",
      BB_DESKTOP_LAB_SMOKE_MODE: "1",
      BB_DESKTOP_LAB_EXPECTED_CONFIG: JSON.stringify({
        dataDir: join(homeDir, "owned", ".bb-lab"),
        appDataDir: join(homeDir, "owned", "app-data"),
        userDataDir: join(homeDir, "owned", "user-data"),
        bindHost: "127.0.0.1",
        serverPort: "39012",
        daemonPort: "39013",
      }),
    };
    const expected = createExpectedLabRuntimeConfig({
      env: overrides,
      homeDir,
    });
    const separatelySerializedExpected = JSON.stringify(expected);
    const correctlyResolved = createDesktopProfileEnvironment({
      env: {
        ...overrides,
        BB_DESKTOP_LAB_SMOKE_MODE: "1",
        BB_DESKTOP_LAB_EXPECTED_CONFIG: separatelySerializedExpected,
      },
      expectedLabRuntimeConfig: expected,
      homeDir,
      profile: "lab",
    });

    expect(correctlyResolved).toMatchObject({
      BB_DATA_DIR: expected.dataDir,
      BB_DESKTOP_APP_DATA_DIR: expected.appDataDir,
      BB_DESKTOP_USER_DATA_DIR: expected.userDataDir,
      BB_SERVER_BIND_HOST: expected.bindHost,
      BB_SERVER_PORT: expected.serverPort,
      BB_HOST_DAEMON_PORT: expected.daemonPort,
    });

    const droppedOverrides: NodeJS.ProcessEnv = { ...overrides };
    for (const key of Object.keys(overrides)) {
      delete droppedOverrides[key];
    }
    expect(() =>
      createDesktopProfileEnvironment({
        env: {
          ...droppedOverrides,
          BB_DESKTOP_LAB_SMOKE_MODE: "1",
          BB_DESKTOP_LAB_EXPECTED_CONFIG: separatelySerializedExpected,
        },
        expectedLabRuntimeConfig: expected,
        homeDir,
        profile: "lab",
      }),
    ).toThrow("did not match its expected isolated target");

    const misrouted = createDesktopProfileEnvironment({
      env: droppedOverrides,
      homeDir,
      profile: "lab",
    });

    expect(misrouted.BB_DATA_DIR).not.toBe(expected.dataDir);
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(join(homeDir, "owned")),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["relative existing prefix", "relative"],
    ["tilde-prefixed existing prefix", "tilde"],
  ])(
    "rejects Lab override paths with %s that resolve into normal bb data",
    async (_label, rawPath) => {
      const homeDir = await createHomeDirectory();
      await mkdir(join(homeDir, "bb"), { recursive: true });
      await symlink(join(homeDir, "bb"), join(homeDir, ".bb"));
      const childPath = join(homeDir, ".bb", "missing", "child");
      const overridePath =
        _label === "relative existing prefix"
          ? relative(process.cwd(), childPath)
          : `~/${relative(homeDir, childPath)}`;

      expect(() =>
        createDesktopProfileEnvironment({
          env: { BB_LAB_DATA_DIR: overridePath },
          homeDir,
          profile: "lab",
        }),
      ).toThrow("must not alias the normal ~/.bb directory");
    },
  );

  it.each([
    ["relative path", "lab-state", "lab-state"],
    ["tilde path", "~/lab-state", "lab-state"],
  ])("normalizes a Lab %s override", async (_label, rawPath, suffix) => {
    const homeDir = await createHomeDirectory();
    const env = createDesktopProfileEnvironment({
      env: { BB_LAB_DATA_DIR: rawPath },
      homeDir,
      profile: "lab",
    });

    expect(env.BB_DATA_DIR).toBe(
      _label === "relative path" ? resolve(suffix) : join(homeDir, suffix),
    );
  });

  it("preserves Personal runtime settings and isolates Electron preferences", async () => {
    const homeDir = await createHomeDirectory();
    const env = createDesktopProfileEnvironment({
      env: {
        BB_DATA_DIR: join(homeDir, ".bb"),
        BB_PERSONAL_USER_DATA_DIR: join(homeDir, "personal-preferences"),
        BB_PERSONAL_APP_DATA_DIR: join(homeDir, "personal-app-data"),
        BB_SERVER_PORT: "38886",
      },
      homeDir,
      profile: "personal",
    });

    expect(env).toMatchObject({
      BB_DATA_DIR: join(homeDir, ".bb"),
      BB_DESKTOP_APP_DATA_DIR: join(homeDir, "personal-app-data"),
      BB_DESKTOP_USER_DATA_DIR: join(homeDir, "personal-preferences"),
      BB_SERVER_PORT: "38886",
    });
    expect(env).not.toHaveProperty("BB_PERSONAL_USER_DATA_DIR");
  });

  it.each([
    "BB_LAB_DATA_DIR",
    "BB_LAB_USER_DATA_DIR",
    "BB_LAB_APP_DATA_DIR",
  ] as const)(
    "rejects a Lab %s symlink into normal bb data",
    async (pathVariable) => {
      const homeDir = await createHomeDirectory();
      const normalDataDir = join(homeDir, ".bb");
      await mkdir(normalDataDir);
      const linkPath = join(homeDir, ".bb-lab-alias");
      await symlink(normalDataDir, linkPath);

      expect(() =>
        createDesktopProfileEnvironment({
          env: { [pathVariable]: linkPath },
          homeDir,
          profile: "lab",
        }),
      ).toThrow("must not alias the normal ~/.bb directory");
    },
  );
});
