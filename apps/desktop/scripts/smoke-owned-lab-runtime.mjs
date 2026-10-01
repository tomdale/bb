import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, waitForChildExit } from "./child-process-helpers.mjs";
import { appendOutput, formatProcessOutput } from "./smoke-output.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";
import { parseExpectedLabRuntimeConfig } from "./lab-runtime-config.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const outputRoot = join(desktopPackageRoot, "release", "lab");
const productName = "bb Lab";
const executableName = "bb-lab";
const startupTimeoutMs = 90_000;
const shutdownTimeoutMs = 20_000;
const syntheticDailyEnv = {
  BB_APP_NPM_PREFIX: "/synthetic/daily/npm",
  BB_APP_SURFACE: "web",
  BB_APP_UPDATE_MODE: "app",
  BB_APP_VERSION: "99.0.0-daily",
  BB_BRIDGE_DIR: "/synthetic/daily/bridges",
  BB_CLI: "/synthetic/daily/bin/bb",
  BB_CLI_DIR: "/synthetic/daily/daemon",
  BB_CLI_REEXEC: "1",
  BB_CONNECT_MACHINE_CREDENTIAL: "synthetic-daily-credential",
  BB_CONNECT_MACHINE_ID: "synthetic-daily-machine",
  BB_DEV_APP_PORT: "12345",
  BB_FF_PLACEHOLDER: "true",
  BB_FF_TIMELINE_WINDOW_EVENT_BUDGET: "99",
  BB_HOST_DAEMON_AUTO_UPDATE: "1",
  BB_HOST_DAEMON_SUPERVISED: "1",
  BB_HOST_ENROLL_KEY: "synthetic-daily-enroll-key",
  BB_HOST_ID: "synthetic-daily-host",
  BB_HOST_NAME: "synthetic-daily-name",
  BB_INFERENCE: "synthetic-daily-inference",
  BB_INFERENCE_FALLBACK: "synthetic-daily-fallback",
  BB_INHERITED_SKILLS_ROOTS: "/synthetic/daily/skills",
  BB_LOG_LEVEL: "trace",
  BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD: "1",
  BB_MARKETPLACE_URL: "https://daily.example.test/marketplace.json",
  BB_POSTHOG_API_KEY: "synthetic-daily-telemetry-key",
  BB_PROVIDER_BRIDGE_RECORD_DIR: "/synthetic/daily/recordings",
  BB_SERVER_HEADERS: '{"authorization":"synthetic-daily-header"}',
  BB_SERVER_LAUNCH_ID: "synthetic-daily-launch",
  BB_TELEMETRY: "true",
  BB_TRANSCRIPTION: "synthetic-daily-transcription",
  BB_PERSONAL_USER_DATA_DIR: "/synthetic/daily/electron-user",
  BB_PERSONAL_APP_DATA_DIR: "/synthetic/daily/electron-app",
  BB_LAB_DATA_DIR: "/synthetic/daily/lab-data",
  BB_LAB_USER_DATA_DIR: "/synthetic/daily/lab-user",
  BB_LAB_APP_DATA_DIR: "/synthetic/daily/lab-app",
  BB_LAB_SERVER_PORT: "38886",
  BB_LAB_HOST_DAEMON_PORT: "38887",
  BB_SERVER_URL: "http://127.0.0.1:38886",
  BB_SERVER_PORT: "38886",
  BB_HOST_DAEMON_PORT: "38887",
  BB_SERVER_BIND_HOST: "0.0.0.0",
  BB_DATA_DIR: "/synthetic/daily/data",
  BB_DESKTOP_APP_URL: "https://daily.example.test/app",
  BB_APP_URL: "https://daily.example.test",
  BB_EXTERNAL_URL: "https://daily.example.test",
  BB_DEV_APP_HOST: "daily-example.test",
  BB_WORKTREE_POLICY: "daily-policy",
  BB_ENVIRONMENT_ID: "daily-environment",
  XDG_CONFIG_HOME: "/synthetic/daily/config",
};
const pollIntervalMs = 200;
const runtimeInstallArtifacts = [
  "auth.json",
  "host-id",
  "config.json",
  "env.json",
  "daemon.lock",
  "bb-app-runtime.json",
];

async function allocatePorts(count) {
  const reservations = [];
  try {
    while (reservations.length < count) {
      const reservation = createServer();
      await new Promise((resolveListen, rejectListen) => {
        reservation.once("error", rejectListen);
        reservation.listen(0, "127.0.0.1", () => {
          reservation.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = reservation.address();
      if (address === null || typeof address === "string") {
        throw new Error("A reserved TCP socket did not expose its port");
      }
      if (!reservations.some((entry) => entry.port === address.port)) {
        reservations.push({ port: address.port, server: reservation });
      } else {
        await new Promise((resolveClose, rejectClose) => {
          reservation.close((error) =>
            error === undefined ? resolveClose() : rejectClose(error),
          );
        });
      }
    }
    return reservations.map((entry) => entry.port);
  } finally {
    await Promise.all(
      reservations.map(
        ({ server }) =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) =>
              error === undefined ? resolveClose() : rejectClose(error),
            );
          }),
      ),
    );
  }
}

async function waitForCondition({ describe, predicate }) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result !== false && result !== null && result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${describe}.${detail}`);
}

async function probeJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForRuntime({
  dataDir,
  daemonPort,
  pidFile,
  serverPort,
  bridgePath,
}) {
  return waitForCondition({
    describe: `Lab server and host daemon (${serverPort}, ${daemonPort}) to become healthy`,
    async predicate() {
      const [
        serverHealth,
        systemConfig,
        daemonHealth,
        daemonStatus,
        ownedRuntime,
      ] = await Promise.all([
        probeJson(`http://127.0.0.1:${serverPort}/health`),
        probeJson(`http://127.0.0.1:${serverPort}/api/v1/system/config`),
        fetch(`http://127.0.0.1:${daemonPort}/health`, {
          signal: AbortSignal.timeout(1_000),
        }),
        probeJson(`http://127.0.0.1:${daemonPort}/status`),
        readFile(pidFile, "utf8").then((raw) => JSON.parse(raw)),
      ]);
      if (
        serverHealth.ok !== true ||
        systemConfig.dataDir !== dataDir ||
        systemConfig.hostDaemonPort !== daemonPort ||
        daemonHealth.status !== 200 ||
        (await daemonHealth.text()) !== "ok" ||
        daemonStatus.serverUrl !== `http://127.0.0.1:${serverPort}` ||
        daemonStatus.connected !== true ||
        ownedRuntime.bridgePath !== bridgePath ||
        ownedRuntime.serverUrl !== `http://127.0.0.1:${serverPort}` ||
        typeof ownedRuntime.startedAt !== "string" ||
        !Number.isInteger(ownedRuntime.pid) ||
        ownedRuntime.pid < 1
      ) {
        return false;
      }
      return ownedRuntime;
    },
  });
}

function readProcessCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 1
    ) {
      return null;
    }
    throw error;
  }
}

async function stopOwnedDesktop(child, appBinary) {
  const command = readProcessCommand(child.pid);
  if (
    command === null ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  if (!command.includes(appBinary)) {
    throw new Error(
      `Packaged Lab app PID ${child.pid} no longer matches ${appBinary}; leaving it untouched.`,
    );
  }
  child.kill("SIGTERM");
  if (!(await waitForChildExit(child, shutdownTimeoutMs))) {
    throw new Error(
      `Lab desktop PID ${child.pid} did not exit; retaining test data.`,
    );
  }
}

function listListeningPids(port) {
  try {
    return execFileSync(
      "lsof",
      ["-nP", "-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split(/\s+/u)
      .filter((pid) => pid.length > 0)
      .map(Number);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 1
    ) {
      return [];
    }
    throw error;
  }
}

async function readOwnedRuntimePid(pidFile, bridgePath, serverUrl) {
  try {
    const runtime = JSON.parse(await readFile(pidFile, "utf8"));
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      runtime.bridgePath !== bridgePath ||
      runtime.serverUrl !== serverUrl ||
      typeof runtime.startedAt !== "string" ||
      !Number.isFinite(Date.parse(runtime.startedAt)) ||
      !Number.isInteger(runtime.pid) ||
      runtime.pid < 1
    ) {
      throw new Error(
        "Owned Lab runtime marker did not match the packaged bridge",
      );
    }
    return runtime.pid;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function waitForOwnedRuntimeExit(
  runtimePid,
  pidFile,
  bridgePath,
  serverUrl,
) {
  await waitForCondition({
    describe: `owned runtime PID ${runtimePid} to exit and its marker to be removed`,
    async predicate() {
      let markerExists = true;
      try {
        await access(pidFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        markerExists = false;
      }
      if (markerExists) {
        const markerPid = await readOwnedRuntimePid(
          pidFile,
          bridgePath,
          serverUrl,
        );
        if (markerPid !== runtimePid) {
          throw new Error(
            "Lab runtime marker changed identity; retaining test data.",
          );
        }
      }
      const command = readProcessCommand(runtimePid);
      if (command !== null && !command.includes(bridgePath)) {
        throw new Error(
          `Runtime PID ${runtimePid} changed identity while shutting down; leaving it untouched.`,
        );
      }
      return !markerExists && command === null;
    },
  });
}

async function waitForPortsToClose(ports) {
  await waitForCondition({
    describe: `owned Lab runtime listeners ${ports.join(", ")} to stop`,
    predicate: () =>
      ports.every((port) => listListeningPids(port).length === 0),
  });
}

async function run() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Packaged Lab runtime smoke runs on macOS or Linux.");
  }
  const appBinary = await resolvePackagedAppBinary({
    executableName,
    platform: process.platform,
    productName,
    releaseDir: outputRoot,
  });
  const resourcesPath = resolve(dirname(appBinary), "..", "Resources");
  const bridgePath = join(
    resourcesPath,
    "app.asar.unpacked",
    "dist",
    "bb-app-bridge.mjs",
  );
  await access(bridgePath);

  const ports = await allocatePorts(2);
  const [serverPort, daemonPort] = ports;
  const smokeRoot = await mkdtemp(join(tmpdir(), "bb-desktop-lab-runtime-"));
  const homeDir = process.env.HOME ?? tmpdir();
  const dataDir = join(smokeRoot, "data", ".bb-lab");
  const userDataDir = join(smokeRoot, "user-data");
  const appDataDir = join(smokeRoot, "app-data");
  const pidFile = join(userDataDir, "owned-runtime.json");
  const stdout = [];
  const stderr = [];
  let child;
  let runtimePid;
  try {
    const inheritedWithSentinels = {
      ...process.env,
      ...syntheticDailyEnv,
    };
    for (const key of Object.keys(syntheticDailyEnv)) {
      delete inheritedWithSentinels[key];
    }
    const independentlySpecifiedTarget = {
      dataDir: resolve(dataDir),
      appDataDir: resolve(appDataDir),
      userDataDir: resolve(userDataDir),
      bindHost: "127.0.0.1",
      serverPort: String(serverPort),
      daemonPort: String(daemonPort),
    };
    const expectedConfig = parseExpectedLabRuntimeConfig({
      serializedExpected: JSON.stringify(independentlySpecifiedTarget),
      homeDir: process.env.HOME,
    });
    const testOverrides = {
      HOME: process.env.HOME,
      BB_DESKTOP_BUILD_PROFILE: "lab",
      BB_DESKTOP_LAB_SMOKE_MODE: "1",
      BB_DESKTOP_LAB_EXPECTED_CONFIG: JSON.stringify(
        independentlySpecifiedTarget,
      ),
      BB_LAB_DATA_DIR: dataDir,
      BB_LAB_USER_DATA_DIR: userDataDir,
      BB_LAB_APP_DATA_DIR: appDataDir,
      BB_LAB_SERVER_PORT: String(serverPort),
      BB_LAB_HOST_DAEMON_PORT: String(daemonPort),
      BB_DESKTOP_OPEN_DEVTOOLS: "0",
    };
    const launchEnv = { ...inheritedWithSentinels, ...testOverrides };
    console.log(
      `Launching owned Lab runtime with expectedData=${expectedConfig.dataDir}, expectedUserData=${expectedConfig.userDataDir}, expectedAppData=${expectedConfig.appDataDir}, serverPort=${expectedConfig.serverPort}, daemonPort=${expectedConfig.daemonPort}, bridge=${bridgePath}, scrubbedInheritedVariables=${Object.keys(syntheticDailyEnv).join(",")}`,
    );
    child = spawn(
      appBinary,
      [
        ...createPackagedAppLaunchArguments({
          platform: process.platform,
          userDataDir: expectedConfig.userDataDir,
        }),
        "--bb-lab-smoke",
      ],
      {
        cwd: homeDir,
        env: launchEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendOutput(stderr, chunk);
    });
    await waitForCondition({
      describe:
        "independent Lab configuration acknowledgment before startup writes",
      predicate: () =>
        stdout
          .join("")
          .split("\n")
          .includes(
            `BB_LAB_CONFIG_VALIDATED ${JSON.stringify(expectedConfig)}`,
          ),
    });
    const runtime = await waitForRuntime({
      bridgePath,
      dataDir: expectedConfig.dataDir,
      daemonPort: Number(expectedConfig.daemonPort),
      pidFile,
      serverPort: Number(expectedConfig.serverPort),
    });
    runtimePid = runtime.pid;
    console.log(
      `Owned Lab runtime ready: appPid=${child.pid}, runtimePid=${runtimePid}, data=${expectedConfig.dataDir}, serverPort=${expectedConfig.serverPort}, daemonPort=${expectedConfig.daemonPort}, desktopLogs=${stdout.length} stdout chunks/${stderr.length} stderr chunks`,
    );
    const labArtifacts = await Promise.all(
      runtimeInstallArtifacts.map(async (fileName) => {
        try {
          await access(join(expectedConfig.dataDir, fileName));
          return fileName;
        } catch {
          return null;
        }
      }),
    );
    console.log(
      `Owned Lab data artifacts present: ${labArtifacts.filter(Boolean).join(",")}`,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${formatProcessOutput({ stdout, stderr })}`,
    );
  } finally {
    let cleanupFailure = null;
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailure ??= error;
      }
    };
    if (child !== undefined) {
      await cleanup(() => stopOwnedDesktop(child, appBinary));
    }
    if (runtimePid === undefined) {
      await cleanup(async () => {
        runtimePid = await readOwnedRuntimePid(
          pidFile,
          bridgePath,
          `http://127.0.0.1:${serverPort}`,
        );
      });
    }
    if (runtimePid !== undefined) {
      const pidToStop = runtimePid;
      await cleanup(async () => {
        await waitForOwnedRuntimeExit(
          pidToStop,
          pidFile,
          bridgePath,
          `http://127.0.0.1:${serverPort}`,
        );
      });
    }
    await cleanup(() => waitForPortsToClose(ports));
    await cleanup(async () => {
      if (child !== undefined && readProcessCommand(child.pid) !== null) {
        throw new Error("Lab desktop is still running; retaining test data.");
      }
      if (runtimePid !== undefined && readProcessCommand(runtimePid) !== null) {
        throw new Error("Lab runtime is still running; retaining test data.");
      }
    });
    if (cleanupFailure !== null) {
      throw new Error(`Lab cleanup failed; retained ${smokeRoot}`, {
        cause: cleanupFailure,
      });
    }
    await rm(smokeRoot, { force: true, recursive: true });
  }
  console.log(
    `Owned Lab runtime smoke passed and cleaned its runtime PID ${runtimePid} and listeners ${ports.join(", ")}.`,
  );
}

await run().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : error;
  console.error(message);
  process.exitCode = 1;
});
