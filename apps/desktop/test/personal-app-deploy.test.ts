import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPersonalDeployEnv,
  findBusyThreads,
  parseDeployArguments,
  parseProcessTable,
  resolveDeployPaths,
  restorePreviousBundle,
  runRestart,
  selectBundleProcesses,
  selectMainProcess,
  swapInBundle,
  waitForIdleThreads,
  type RestartEffects,
  type ThreadListing,
} from "../scripts/personal-app-deploy.mjs";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "bb-personal-deploy-"));
  tempDirectories.push(directory);
  return directory;
}

function fakeBundle(path: string, marker: string) {
  mkdirSync(join(path, "Contents"), { recursive: true });
  writeFileSync(join(path, "Contents", "marker"), marker);
}

function bundleMarker(path: string) {
  return readFileSync(join(path, "Contents", "marker"), "utf8");
}

it("relaunches independently of the calling agent session", () => {
  const sourceEnv = {
    PATH: "/tools/bin",
    OPENAI_API_KEY: "test-provider-key",
    BB_THREAD_ID: "thr_deploy",
    BB_PROJECT_ID: "proj_deploy",
    BB_ENVIRONMENT_ID: "env_deploy",
    BB_THREAD_STORAGE: "/thread-storage",
    ELECTRON_RUN_AS_NODE: "1",
    PI_BB_TOOLS_FILE: "/previous-session/tools.json",
  };
  expect(buildPersonalDeployEnv(sourceEnv)).toEqual({
    PATH: "/tools/bin",
    OPENAI_API_KEY: "test-provider-key",
  });
  expect(sourceEnv.PI_BB_TOOLS_FILE).toBe("/previous-session/tools.json");
});

describe("deploy arguments", () => {
  it("builds, smokes, replaces, and waits by default", () => {
    expect(parseDeployArguments([])).toMatchObject({
      build: true,
      smoke: true,
      replace: true,
      force: false,
      waitTimeoutMinutes: 60,
      reportThreadId: null,
    });
  });

  it("restarts the installed app without building or replacing it", () => {
    expect(parseDeployArguments(["--restart-only"])).toMatchObject({
      build: false,
      smoke: false,
      replace: false,
    });
  });

  it("rejects malformed values and unknown options", () => {
    expect(() => parseDeployArguments(["--wait-timeout", "soon"])).toThrow(
      /minutes/,
    );
    expect(() => parseDeployArguments(["--report-thread", "nope"])).toThrow(
      /thread id/,
    );
    expect(() => parseDeployArguments(["--report-thread"])).toThrow(
      /needs a value/,
    );
    expect(() => parseDeployArguments(["--now"])).toThrow(/Unknown option/);
  });

  it("keeps deploy state under XDG_STATE_HOME", () => {
    expect(
      resolveDeployPaths({
        env: { XDG_STATE_HOME: "/state" },
        homeDir: "/home/u",
      }),
    ).toMatchObject({
      appPath: "/Applications/bb Personal.app",
      executablePath:
        "/Applications/bb Personal.app/Contents/MacOS/bb Personal",
      stagedPath: "/state/bb-personal-deploy/staged/bb Personal.app",
      previousPath: "/state/bb-personal-deploy/previous/bb Personal.app",
    });
    expect(resolveDeployPaths({ env: {}, homeDir: "/home/u" }).stateDir).toBe(
      "/home/u/.local/state/bb-personal-deploy",
    );
  });
});

describe("app processes", () => {
  const appPath = "/Applications/bb Personal.app";
  const executablePath = `${appPath}/Contents/MacOS/bb Personal`;

  it("finds the main process by its argument-free command line", () => {
    const commandLines = parseProcessTable(
      [
        `  101 ${executablePath} ${appPath}/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/index.js`,
        `   42 ${executablePath}`,
        `  202 /usr/local/bin/node ${appPath}/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb thread list`,
      ].join("\n"),
    );
    expect(selectMainProcess({ commandLines, executablePath })).toBe(42);
    expect(selectMainProcess({ commandLines: [], executablePath })).toBeNull();
  });

  it("counts every process running from the bundle, not from elsewhere", () => {
    const executables = parseProcessTable(
      [
        `   42 ${executablePath}`,
        `   43 ${appPath}/Contents/Frameworks/bb Personal Helper.app/Contents/MacOS/bb Personal Helper`,
        "  202 /usr/local/bin/node",
        "  303 /Applications/bb Personal Lab.app/Contents/MacOS/bb Personal Lab",
      ].join("\n"),
    );
    expect(selectBundleProcesses({ executables, appPath })).toEqual([42, 43]);
  });
});

describe("bundle replacement", () => {
  function layout() {
    const root = tempDirectory();
    return {
      appPath: join(root, "Applications", "bb Personal.app"),
      stagedPath: join(root, "state", "staged", "bb Personal.app"),
      previousPath: join(root, "state", "previous", "bb Personal.app"),
      failedPath: join(root, "state", "failed", "bb Personal.app"),
    };
  }

  it("moves the installed app aside and the staged app into place", () => {
    const paths = layout();
    fakeBundle(paths.appPath, "old");
    fakeBundle(paths.stagedPath, "new");
    fakeBundle(paths.previousPath, "older");
    expect(swapInBundle(paths)).toEqual({ hadPrevious: true });
    expect(bundleMarker(paths.appPath)).toBe("new");
    expect(bundleMarker(paths.previousPath)).toBe("old");
    expect(existsSync(paths.stagedPath)).toBe(false);
  });

  it("refuses to swap without a staged app and leaves the installed app alone", () => {
    const paths = layout();
    fakeBundle(paths.appPath, "old");
    expect(() => swapInBundle(paths)).toThrow(/No staged app/);
    expect(bundleMarker(paths.appPath)).toBe("old");
  });

  it("restores the previous app and keeps the failed one for inspection", () => {
    const paths = layout();
    fakeBundle(paths.appPath, "new");
    fakeBundle(paths.previousPath, "old");
    restorePreviousBundle(paths);
    expect(bundleMarker(paths.appPath)).toBe("old");
    expect(bundleMarker(paths.failedPath)).toBe("new");
  });
});

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

function listings(...results: ThreadListing[]) {
  return async () => (results.length > 1 ? results.shift()! : results[0]!);
}

const busy = (id: string): ThreadListing => ({
  ok: true,
  threads: [
    { id, status: "active", title: "work" },
    { id: "thr_idle", status: "idle" },
  ],
});
const idle: ThreadListing = {
  ok: true,
  threads: [{ id: "thr_a", status: "idle" }],
};

describe("waiting for idle threads", () => {
  it("only counts starting, active, and stopping threads as busy", () => {
    expect(
      findBusyThreads([
        { id: "a", status: "pending" },
        { id: "b", status: "starting" },
        { id: "c", status: "active" },
        { id: "d", status: "stopping" },
        { id: "e", status: "error" },
      ]).map((thread) => thread.id),
    ).toEqual(["b", "c", "d"]);
  });

  it("waits until threads stay idle for the settle checks", async () => {
    const messages: string[] = [];
    const result = await waitForIdleThreads({
      ...clock(),
      listThreads: listings(busy("thr_a"), idle, busy("thr_b"), idle, idle),
      timeoutMs: 60_000,
      pollMs: 5_000,
      settleChecks: 2,
      log: (message) => messages.push(message),
    });
    expect(result).toEqual({ idle: true, busy: [] });
    expect(messages).toEqual([
      "waiting for 1 busy thread(s): thr_a (active) work",
      "waiting for 1 busy thread(s): thr_b (active) work",
    ]);
  });

  it("gives up at the deadline and names what is still busy", async () => {
    const result = await waitForIdleThreads({
      ...clock(),
      listThreads: listings(busy("thr_long")),
      timeoutMs: 20_000,
      pollMs: 5_000,
      settleChecks: 2,
      log: () => {},
    });
    expect(result.idle).toBe(false);
    expect(result.busy.map((thread) => thread.id)).toEqual(["thr_long"]);
  });

  it("does not treat an unreadable thread list as idle", async () => {
    const result = await waitForIdleThreads({
      ...clock(),
      listThreads: listings({ ok: false, error: "server unavailable" }),
      timeoutMs: 10_000,
      pollMs: 5_000,
      settleChecks: 1,
      log: () => {},
    });
    expect(result.idle).toBe(false);
  });
});

describe("restart orchestration", () => {
  const config = {
    appPath: "/Applications/bb Personal.app",
    stagedPath: "/state/staged/bb Personal.app",
    replace: true,
    force: false,
    waitTimeoutMs: 60_000,
    pollMs: 5_000,
    settleChecks: 1,
    commit: "abc123",
  };

  function effects(overrides: Partial<RestartEffects> = {}) {
    const calls: string[] = [];
    const time = clock();
    const base: RestartEffects = {
      log: () => {},
      now: time.now,
      sleep: time.sleep,
      readBundleVersion: (path) =>
        path === config.stagedPath ? "0.45.0" : "0.44.0",
      listThreads: listings(idle),
      health: async () => ({ launchId: "launch-old" }),
      mainProcess: () => 42,
      quitApp: async () => {
        calls.push("quit");
      },
      swapInBundle: () => {
        calls.push("swap");
      },
      restorePreviousBundle: () => {
        calls.push("restore");
      },
      openApp: () => {
        calls.push("open");
      },
      waitForHealth: async (previous) => {
        calls.push(`health:${previous}`);
        return { ok: true, launchId: "launch-new" };
      },
    };
    return { calls, effects: { ...base, ...overrides } };
  }

  it("quits, replaces, relaunches, and requires a new launch", async () => {
    const { calls, effects: fx } = effects();
    const result = await runRestart({ config, effects: fx });
    expect(calls).toEqual(["quit", "swap", "open", "health:launch-old"]);
    expect(result).toMatchObject({
      status: "succeeded",
      fromVersion: "0.44.0",
      toVersion: "0.45.0",
      commit: "abc123",
    });
  });

  it("aborts without touching the app while threads stay busy", async () => {
    const { calls, effects: fx } = effects({
      listThreads: listings(busy("thr_long")),
    });
    const result = await runRestart({ config, effects: fx });
    expect(calls).toEqual([]);
    expect(result.status).toBe("aborted");
    expect(result.message).toMatch(/thr_long.*--skip-build/u);
  });

  it("restarts at once with force", async () => {
    const { calls, effects: fx } = effects({
      listThreads: async () => {
        throw new Error("force must not wait for threads");
      },
    });
    const result = await runRestart({
      config: { ...config, force: true },
      effects: fx,
    });
    expect(calls[0]).toBe("quit");
    expect(result.status).toBe("succeeded");
  });

  it("installs and launches without quitting when the app is not running", async () => {
    const { calls, effects: fx } = effects({ mainProcess: () => null });
    const result = await runRestart({ config, effects: fx });
    expect(calls).toEqual(["swap", "open", "health:null"]);
    expect(result.status).toBe("succeeded");
  });

  it("rolls back to the previous app when the new one never answers", async () => {
    let attempts = 0;
    const { calls, effects: fx } = effects({
      waitForHealth: async (previous) => {
        calls.push(`health:${previous}`);
        attempts += 1;
        return attempts === 1
          ? { ok: false, error: "no new launch" }
          : { ok: true, launchId: "launch-restored" };
      },
    });
    const result = await runRestart({ config, effects: fx });
    expect(calls).toEqual([
      "quit",
      "swap",
      "open",
      "health:launch-old",
      "quit",
      "restore",
      "open",
      "health:null",
    ]);
    expect(result.status).toBe("rolled-back");
  });

  it("does not swap or roll back for a restart-only run", async () => {
    const { calls, effects: fx } = effects({
      waitForHealth: async () => ({ ok: false, error: "no new launch" }),
    });
    const result = await runRestart({
      config: { ...config, replace: false },
      effects: fx,
    });
    expect(calls).toEqual(["quit", "open"]);
    expect(result.status).toBe("failed");
  });
});
