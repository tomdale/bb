import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";
import {
  PERSONAL_PROFILE,
  buildPersonalDeployEnv,
  deployUsage,
  findBusyThreads,
  parseDeployArguments,
  readBundleVersion,
  readProcesses,
  resolveDeployPaths,
  restorePreviousBundle,
  runRestart,
  selectBundleProcesses,
  selectMainProcess,
  swapInBundle,
} from "./personal-app-deploy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const serverUrl = `http://${PERSONAL_PROFILE.serverBindHost}:${PERSONAL_PROFILE.defaultServerPort}`;
const QUIT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 180_000;

const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function run(command, args, options = {}) {
  log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: cleanEnv(),
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`,
    );
  }
}

function bbCli() {
  return process.env.BB_CLI?.trim() ? process.env.BB_CLI : "bb";
}

function cleanEnv() {
  return buildPersonalDeployEnv(process.env);
}

function listThreads() {
  const result = spawnSync(
    bbCli(),
    ["thread", "list", "--json", "--include-hidden"],
    {
      encoding: "utf8",
      env: cleanEnv(),
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      error: (
        result.stderr ||
        result.error?.message ||
        `exit ${result.status}`
      ).trim(),
    };
  }
  try {
    const threads = JSON.parse(result.stdout);
    if (!Array.isArray(threads)) throw new Error("expected a JSON array");
    return { ok: true, threads };
  } catch (error) {
    return { ok: false, error: `unreadable thread list: ${error.message}` };
  }
}

async function readHealth() {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok === true
      ? { launchId: typeof body.launchId === "string" ? body.launchId : null }
      : null;
  } catch {
    return null;
  }
}

function checkoutCommit() {
  const head = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--short", "HEAD"],
    {
      encoding: "utf8",
    },
  );
  if (head.status !== 0) return null;
  const dirty = spawnSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  );
  return `${head.stdout.trim()}${dirty.stdout.trim() ? "+dirty" : ""}`;
}

function readLock(lockPath) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    process.kill(lock.pid, 0);
    return lock;
  } catch {
    return null;
  }
}

async function releaseBundlePath() {
  const binary = await resolvePackagedAppBinary({
    executableName: PERSONAL_PROFILE.linuxExecutableName,
    platform: process.platform,
    productName: PERSONAL_PROFILE.applicationName,
    releaseDir: join(packageRoot, PERSONAL_PROFILE.outputDirectory),
  });
  return resolve(binary, "..", "..", "..");
}

function createRestartEffects(config) {
  const appProcesses = () => {
    const processes = readProcesses();
    return {
      bundle: selectBundleProcesses({
        executables: processes.executables,
        appPath: config.appPath,
      }),
      main: selectMainProcess({
        commandLines: processes.commandLines,
        executablePath: config.executablePath,
      }),
    };
  };
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
    } catch {}
  };
  return {
    log,
    now: () => Date.now(),
    sleep,
    readBundleVersion,
    listThreads: async () => listThreads(),
    health: readHealth,
    mainProcess: () => appProcesses().main,
    async quitApp() {
      const { main } = appProcesses();
      if (main === null) return;
      log(`quitting bb Personal (pid ${main}) with SIGTERM`);
      signal(main, "SIGTERM");
      const deadline = Date.now() + QUIT_TIMEOUT_MS;
      let remaining = appProcesses().bundle;
      while (remaining.length > 0 && Date.now() < deadline) {
        await sleep(500);
        remaining = appProcesses().bundle;
      }
      if (remaining.length > 0) {
        log(
          `killing ${remaining.length} process(es) still running from the app: ${remaining.join(", ")}`,
        );
        for (const pid of remaining) signal(pid, "SIGKILL");
        await sleep(2_000);
      }
      log("bb Personal has quit");
    },
    swapInBundle: () => swapInBundle(config),
    restorePreviousBundle: () => restorePreviousBundle(config),
    openApp() {
      log(`opening ${config.appPath}`);
      const result = spawnSync("/usr/bin/open", [config.appPath], {
        encoding: "utf8",
        env: cleanEnv(),
      });
      if (result.status !== 0) {
        log(`open failed: ${result.stderr.trim()}`);
      }
    },
    async waitForHealth(previousLaunchId) {
      const deadline = Date.now() + HEALTH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const health = await readHealth();
        if (
          health !== null &&
          health.launchId !== previousLaunchId &&
          appProcesses().main !== null
        ) {
          return { ok: true, launchId: health.launchId };
        }
        await sleep(1_000);
      }
      return {
        ok: false,
        error: `no new launch answered ${serverUrl}/health within ${HEALTH_TIMEOUT_MS / 1000} s`,
      };
    },
  };
}

function report(config, result) {
  const summary = `bb Personal deploy ${result.status}: ${result.message}.`;
  const details = [
    `From ${result.fromVersion ?? "unknown"}${result.toVersion ? ` to ${result.toVersion}` : ""}${result.commit ? ` (checkout ${result.commit})` : ""}.`,
    `Log: ${config.logPath}`,
  ].join(" ");
  spawnSync("/usr/bin/osascript", [
    "-e",
    `display notification ${JSON.stringify(result.message)} with title ${JSON.stringify(`bb Personal deploy ${result.status}`)}`,
  ]);
  if (config.reportThreadId === null) return;
  const messagePath = join(config.stateDir, "report-message.md");
  writeFileSync(messagePath, `${summary}\n\n${details}\n`);
  const told = spawnSync(
    bbCli(),
    ["thread", "tell", config.reportThreadId, "--message-file", messagePath],
    { encoding: "utf8", env: cleanEnv(), timeout: 60_000 },
  );
  log(
    told.status === 0
      ? `reported to ${config.reportThreadId}`
      : `could not report to ${config.reportThreadId}: ${(told.stderr || "").trim()}`,
  );
}

async function restartMain(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(
    config.lockPath,
    JSON.stringify({ pid: process.pid, startedAt: timestamp() }),
  );
  log(`restarter started (pid ${process.pid}) with ${configPath}`);
  let result;
  try {
    result = await runRestart({
      config,
      effects: createRestartEffects(config),
    });
  } catch (error) {
    result = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      fromVersion: null,
      toVersion: null,
      commit: config.commit ?? null,
      finishedAt: timestamp(),
    };
    log(`failed: ${result.message}`);
  }
  writeFileSync(
    config.lastResultPath,
    `${JSON.stringify({ ...result, logPath: config.logPath }, null, 2)}\n`,
  );
  rmSync(config.lockPath, { force: true });
  report(config, result);
  process.exitCode = result.status === "succeeded" ? 0 : 1;
}

async function deployMain(options) {
  if (process.platform !== "darwin") {
    throw new Error(
      "deploy-personal-app installs a macOS app bundle; run it on macOS",
    );
  }
  const paths = resolveDeployPaths();
  const lock = readLock(paths.lockPath);
  if (lock !== null) {
    throw new Error(
      `A restart is already pending (pid ${lock.pid}, since ${lock.startedAt}); see ${paths.logDir}`,
    );
  }
  const commit = checkoutCommit();

  if (options.dryRun) {
    const listing = listThreads();
    const busy = listing.ok ? findBusyThreads(listing.threads) : [];
    let release = null;
    try {
      release = await releaseBundlePath();
    } catch {}
    const lines = [
      `checkout:        ${repoRoot} (${commit ?? "unknown"})`,
      `installed app:   ${paths.appPath} (${readBundleVersion(paths.appPath) ?? "missing"})`,
      `release bundle:  ${release ?? "not built"}${release ? ` (${readBundleVersion(release) ?? "unknown"})` : ""}`,
      `state dir:       ${paths.stateDir}`,
      `app running:     ${readProcesses().commandLines.some((process) => process.value === paths.executablePath) ? "yes" : "no"}`,
      `busy threads:    ${listing.ok ? busy.map((thread) => `${thread.id} (${thread.status})`).join(", ") || "none" : `unknown (${listing.error})`}`,
      `steps:           ${[
        options.build && "build",
        options.smoke && "smoke",
        options.replace && "stage+replace",
        options.force
          ? "restart now"
          : `restart when idle (≤ ${options.waitTimeoutMinutes} min)`,
        options.reportThreadId && `report to ${options.reportThreadId}`,
      ]
        .filter(Boolean)
        .join(" → ")}`,
    ];
    console.log(lines.join("\n"));
    return;
  }

  if (options.build) {
    run("pnpm", [
      "exec",
      "turbo",
      "run",
      "package:personal",
      "--filter=@bb/desktop",
    ]);
  }
  let releasePath = null;
  if (options.replace) {
    releasePath = await releaseBundlePath();
    log(
      `release bundle: ${releasePath} (${readBundleVersion(releasePath) ?? "unknown version"})`,
    );
  }
  if (options.smoke) {
    run("pnpm", [
      "exec",
      "turbo",
      "run",
      "smoke:packaged:personal",
      "--filter=@bb/desktop",
    ]);
  }
  mkdirSync(paths.logDir, { recursive: true });
  if (releasePath !== null) {
    rmSync(paths.stagedPath, { recursive: true, force: true });
    mkdirSync(dirname(paths.stagedPath), { recursive: true });
    run("/usr/bin/ditto", [releasePath, paths.stagedPath]);
  }

  const logPath = join(
    paths.logDir,
    `deploy-${timestamp().replace(/[:.]/gu, "-")}.log`,
  );
  const config = {
    ...paths,
    replace: options.replace,
    force: options.force,
    waitTimeoutMs: options.waitTimeoutMinutes * 60_000,
    pollMs: 5_000,
    settleChecks: 2,
    reportThreadId: options.reportThreadId,
    commit,
    logPath,
  };
  const configPath = join(paths.stateDir, "restart-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [scriptPath, "--restart", configPath], {
    cwd: paths.stateDir,
    detached: true,
    env: cleanEnv(),
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(
    paths.lockPath,
    JSON.stringify({ pid: child.pid, startedAt: timestamp() }),
  );

  const listing = listThreads();
  const busy = listing.ok ? findBusyThreads(listing.threads) : [];
  const ownThread = process.env.BB_THREAD_ID;
  console.log(
    [
      `Restart handed off to pid ${child.pid}; log: ${logPath}`,
      options.force
        ? "It restarts bb Personal now, interrupting running threads."
        : `It restarts bb Personal once no thread is busy (now ${busy.length}${ownThread && busy.some((thread) => thread.id === ownThread) ? `, including this thread ${ownThread} until its turn ends` : ""}; gives up after ${options.waitTimeoutMinutes} min).`,
      `Result: ${paths.lastResultPath}`,
    ].join("\n"),
  );
}

try {
  const options = parseDeployArguments(process.argv.slice(2));
  if (options.help) {
    console.log(deployUsage());
  } else if (options.restartConfigPath !== null) {
    await restartMain(options.restartConfigPath);
  } else {
    await deployMain(options);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
