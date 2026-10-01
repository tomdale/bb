import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DESKTOP_BUILD_PROFILES } from "./desktop-build-profiles.mjs";
import { resolveIsolatedProfilePath } from "./desktop-profile-paths.mjs";

function resolvePort(value, fallback) {
  const text = value?.trim();
  if (text === undefined || text.length === 0) return String(fallback);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Lab runtime ports must be valid TCP ports");
  }
  return String(port);
}

function validatePorts(serverPort, daemonPort) {
  if (
    serverPort === daemonPort ||
    serverPort === "38886" ||
    serverPort === "38887" ||
    daemonPort === "38886" ||
    daemonPort === "38887"
  ) {
    throw new Error("Lab ports must be distinct and separate from daily ports");
  }
}

export function createExpectedLabRuntimeConfig({ env, homeDir = homedir() }) {
  const profile = DESKTOP_BUILD_PROFILES.lab;
  const expected = {
    dataDir: resolveIsolatedProfilePath({
      path:
        env.BB_LAB_DATA_DIR?.trim() ||
        join(homeDir, profile.defaultDataDirectory),
      homeDir,
    }),
    appDataDir: resolveIsolatedProfilePath({
      path:
        env.BB_LAB_APP_DATA_DIR?.trim() ||
        join(homeDir, profile.defaultAppDataDirectory),
      homeDir,
    }),
    userDataDir: resolveIsolatedProfilePath({
      path:
        env.BB_LAB_USER_DATA_DIR?.trim() ||
        join(homeDir, profile.defaultUserDataDirectory),
      homeDir,
    }),
    bindHost: profile.serverBindHost,
    serverPort: resolvePort(env.BB_LAB_SERVER_PORT, profile.defaultServerPort),
    daemonPort: resolvePort(
      env.BB_LAB_HOST_DAEMON_PORT,
      profile.defaultHostDaemonPort,
    ),
  };
  validatePorts(expected.serverPort, expected.daemonPort);
  return expected;
}

export function parseExpectedLabRuntimeConfig({
  serializedExpected,
  homeDir = homedir(),
}) {
  return parseExpectedLabRuntimeConfigValue(serializedExpected, homeDir);
}

function parseExpectedLabRuntimeConfigValue(value, homeDir) {
  let raw;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("BB_DESKTOP_LAB_EXPECTED_CONFIG must contain valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("BB_DESKTOP_LAB_EXPECTED_CONFIG must be a JSON object");
  }
  for (const field of [
    "dataDir",
    "appDataDir",
    "userDataDir",
    "bindHost",
    "serverPort",
    "daemonPort",
  ]) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      throw new Error(
        `BB_DESKTOP_LAB_EXPECTED_CONFIG.${field} must be a nonempty string`,
      );
    }
  }
  for (const field of ["dataDir", "appDataDir", "userDataDir"]) {
    if (!isAbsolute(raw[field])) {
      throw new Error(
        `BB_DESKTOP_LAB_EXPECTED_CONFIG.${field} must be absolute`,
      );
    }
    const canonicalPath = resolveIsolatedProfilePath({
      path: raw[field],
      homeDir,
    });
    if (canonicalPath !== raw[field]) {
      throw new Error(
        `BB_DESKTOP_LAB_EXPECTED_CONFIG.${field} must be canonical`,
      );
    }
  }
  const profile = DESKTOP_BUILD_PROFILES.lab;
  if (raw.bindHost !== profile.serverBindHost) {
    throw new Error("BB_DESKTOP_LAB_EXPECTED_CONFIG.bindHost must be loopback");
  }
  const expected = {
    dataDir: raw.dataDir,
    appDataDir: raw.appDataDir,
    userDataDir: raw.userDataDir,
    bindHost: raw.bindHost,
    serverPort: resolvePort(raw.serverPort, profile.defaultServerPort),
    daemonPort: resolvePort(raw.daemonPort, profile.defaultHostDaemonPort),
  };
  validatePorts(expected.serverPort, expected.daemonPort);
  return expected;
}

export function assertLabRuntimeConfig(actual, expected) {
  const matches =
    actual.BB_DATA_DIR === expected.dataDir &&
    actual.BB_DESKTOP_APP_DATA_DIR === expected.appDataDir &&
    actual.BB_DESKTOP_USER_DATA_DIR === expected.userDataDir &&
    actual.BB_SERVER_BIND_HOST === expected.bindHost &&
    actual.BB_SERVER_PORT === expected.serverPort &&
    actual.BB_HOST_DAEMON_PORT === expected.daemonPort;
  if (!matches) {
    throw new Error(
      "Lab runtime configuration did not match its expected isolated target",
    );
  }
}
