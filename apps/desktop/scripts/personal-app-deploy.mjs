import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DESKTOP_BUILD_PROFILES } from "./desktop-build-profiles.mjs";

export const PERSONAL_PROFILE = DESKTOP_BUILD_PROFILES.personal;

export const BUSY_THREAD_STATUSES = new Set(["starting", "active", "stopping"]);

const DEFAULT_WAIT_TIMEOUT_MINUTES = 60;

export function buildPersonalDeployEnv(sourceEnv) {
  const env = { ...sourceEnv };
  for (const key of [
    "BB_THREAD_ID",
    "BB_PROJECT_ID",
    "BB_ENVIRONMENT_ID",
    "BB_THREAD_STORAGE",
    "ELECTRON_RUN_AS_NODE",
    "PI_BB_TOOLS_FILE",
  ]) {
    delete env[key];
  }
  return env;
}

const USAGE = `Usage: deploy-personal-app [options]

Builds bb Personal from this checkout while the installed app keeps running,
then hands the restart to a detached process that waits until no thread is
starting, running, or stopping, quits the app through its normal shutdown,
replaces /Applications/bb Personal.app, relaunches it, and rolls back to the
previous app if the new one does not answer /health.

Options:
  --skip-build            Deploy the existing release/personal artifact
  --skip-smoke            Skip smoke:packaged:personal after building
  --restart-only          Restart the installed app without replacing it
  --force                 Restart without waiting for threads to finish
  --wait-timeout <min>    Minutes to wait for idle threads (default ${DEFAULT_WAIT_TIMEOUT_MINUTES})
  --report-thread <id>    Send the outcome to this bb thread after relaunch
  --dry-run               Print the plan without building or restarting
  -h, --help              Show this help`;

export function deployUsage() {
  return USAGE;
}

export function parseDeployArguments(argv) {
  const options = {
    build: true,
    smoke: true,
    replace: true,
    force: false,
    waitTimeoutMinutes: DEFAULT_WAIT_TIMEOUT_MINUTES,
    reportThreadId: null,
    dryRun: false,
    help: false,
    restartConfigPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case "--skip-build":
        options.build = false;
        break;
      case "--skip-smoke":
        options.smoke = false;
        break;
      case "--restart-only":
        options.build = false;
        options.smoke = false;
        options.replace = false;
        break;
      case "--force":
        options.force = true;
        break;
      case "--wait-timeout": {
        const minutes = Number(value());
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error("--wait-timeout must be a number of minutes");
        }
        options.waitTimeoutMinutes = minutes;
        break;
      }
      case "--report-thread": {
        const threadId = value();
        if (!/^thr_[a-z0-9]+$/u.test(threadId)) {
          throw new Error(
            `--report-thread expects a thread id, got ${threadId}`,
          );
        }
        options.reportThreadId = threadId;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--restart":
        options.restartConfigPath = value();
        break;
      default:
        throw new Error(`Unknown option ${argument}\n\n${USAGE}`);
    }
  }
  return options;
}

export function resolveDeployPaths({
  env = process.env,
  homeDir = homedir(),
  applicationName = PERSONAL_PROFILE.applicationName,
} = {}) {
  const stateHome = env.XDG_STATE_HOME?.trim()
    ? env.XDG_STATE_HOME
    : join(homeDir, ".local", "state");
  const stateDir = join(stateHome, "bb-personal-deploy");
  const bundleName = `${applicationName}.app`;
  const appPath = join("/Applications", bundleName);
  return {
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", applicationName),
    stateDir,
    logDir: join(stateDir, "logs"),
    stagedPath: join(stateDir, "staged", bundleName),
    previousPath: join(stateDir, "previous", bundleName),
    failedPath: join(stateDir, "failed", bundleName),
    lockPath: join(stateDir, "restart.lock"),
    lastResultPath: join(stateDir, "last-deploy.json"),
  };
}

export function findBusyThreads(threads) {
  return threads.filter((thread) => BUSY_THREAD_STATUSES.has(thread.status));
}

export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*)$/u.exec(line);
    if (match) {
      processes.push({ pid: Number(match[1]), value: match[2].trimEnd() });
    }
  }
  return processes;
}

export function selectBundleProcesses({ executables, appPath }) {
  const prefix = `${appPath}/Contents/`;
  return executables
    .filter((process) => process.value.startsWith(prefix))
    .map((process) => process.pid);
}

export function selectMainProcess({ commandLines, executablePath }) {
  return (
    commandLines.find((process) => process.value === executablePath)?.pid ??
    null
  );
}

export function readProcesses() {
  const run = (columns) => {
    const result = spawnSync("ps", ["-axww", "-o", `pid=,${columns}=`], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`ps failed: ${result.stderr}`);
    }
    return parseProcessTable(result.stdout);
  };
  return { executables: run("comm"), commandLines: run("args") };
}

export function readBundleVersion(appPath) {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleShortVersionString",
      join(appPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function moveBundle(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

export function swapInBundle({ appPath, stagedPath, previousPath }) {
  if (!existsSync(stagedPath)) {
    throw new Error(`No staged app at ${stagedPath}`);
  }
  const hadPrevious = existsSync(appPath);
  if (hadPrevious) {
    moveBundle(appPath, previousPath);
  }
  try {
    moveBundle(stagedPath, appPath);
  } catch (error) {
    if (hadPrevious) {
      moveBundle(previousPath, appPath);
    }
    throw error;
  }
  return { hadPrevious };
}

export function restorePreviousBundle({ appPath, previousPath, failedPath }) {
  if (!existsSync(previousPath)) {
    throw new Error(`No previous app at ${previousPath}`);
  }
  if (existsSync(appPath)) {
    moveBundle(appPath, failedPath);
  }
  moveBundle(previousPath, appPath);
}

export async function waitForIdleThreads({
  listThreads,
  sleep,
  now,
  timeoutMs,
  pollMs,
  settleChecks,
  log,
}) {
  const deadline = now() + timeoutMs;
  let idleChecks = 0;
  let lastBusyKey = null;
  for (;;) {
    const listing = await listThreads();
    if (listing.ok) {
      const busy = findBusyThreads(listing.threads);
      if (busy.length === 0) {
        idleChecks += 1;
        if (idleChecks >= settleChecks) {
          return { idle: true, busy: [] };
        }
      } else {
        idleChecks = 0;
        const key = busy
          .map((thread) => `${thread.id}:${thread.status}`)
          .join(",");
        if (key !== lastBusyKey) {
          lastBusyKey = key;
          log(
            `waiting for ${busy.length} busy thread(s): ${busy
              .map((thread) =>
                `${thread.id} (${thread.status}) ${thread.title ?? ""}`.trim(),
              )
              .join("; ")}`,
          );
        }
      }
    } else {
      idleChecks = 0;
      log(`cannot list threads: ${listing.error}`);
    }
    if (now() >= deadline) {
      return {
        idle: false,
        busy: listing.ok ? findBusyThreads(listing.threads) : [],
      };
    }
    await sleep(pollMs);
  }
}

export async function runRestart({ config, effects }) {
  const { log } = effects;
  const result = {
    status: "started",
    fromVersion: effects.readBundleVersion(config.appPath),
    toVersion: config.replace
      ? effects.readBundleVersion(config.stagedPath)
      : null,
    commit: config.commit ?? null,
    startedAt: new Date(effects.now()).toISOString(),
    finishedAt: null,
    message: "",
  };
  const finish = (status, message) => {
    result.status = status;
    result.message = message;
    result.finishedAt = new Date(effects.now()).toISOString();
    log(`${status}: ${message}`);
    return result;
  };

  const wasRunning = effects.mainProcess() !== null;
  const before = wasRunning ? await effects.health() : null;
  if (wasRunning && !config.force) {
    const waited = await waitForIdleThreads({
      listThreads: effects.listThreads,
      sleep: effects.sleep,
      now: effects.now,
      timeoutMs: config.waitTimeoutMs,
      pollMs: config.pollMs,
      settleChecks: config.settleChecks,
      log,
    });
    if (!waited.idle) {
      return finish(
        "aborted",
        `threads still busy after ${Math.round(config.waitTimeoutMs / 60_000)} min (${waited.busy
          .map((thread) => thread.id)
          .join(
            ", ",
          )}); the app was not restarted${config.replace ? "; the staged build is kept for --skip-build" : ""}`,
      );
    }
  }

  if (wasRunning) {
    await effects.quitApp();
  }

  let swapped = false;
  if (config.replace) {
    effects.swapInBundle();
    swapped = true;
    log(
      `installed ${config.appPath} (${result.toVersion ?? "unknown version"})`,
    );
  }

  effects.openApp();
  const started = await effects.waitForHealth(before?.launchId ?? null);
  if (started.ok) {
    return finish(
      "succeeded",
      swapped
        ? `bb Personal ${result.toVersion ?? ""} is running (launch ${started.launchId})`.replace(
            "  ",
            " ",
          )
        : `bb Personal restarted (launch ${started.launchId})`,
    );
  }

  if (!swapped) {
    return finish(
      "failed",
      `bb Personal did not answer /health after relaunch: ${started.error}`,
    );
  }
  log(
    `new app did not answer /health (${started.error}); restoring the previous app`,
  );
  await effects.quitApp();
  effects.restorePreviousBundle();
  effects.openApp();
  const restored = await effects.waitForHealth(null);
  return restored.ok
    ? finish(
        "rolled-back",
        `the new build did not start (${started.error}); the previous app ${result.fromVersion ?? ""} is running again`,
      )
    : finish(
        "failed",
        `neither the new nor the previous app answered /health (${restored.error})`,
      );
}
