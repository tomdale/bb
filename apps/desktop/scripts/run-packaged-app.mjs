import { join } from "node:path";
import { spawn } from "node:child_process";
import { forwardSignalsAndMirrorExit } from "./child-process-helpers.mjs";
import {
  createDesktopApplicationIdentity,
  resolveDesktopBuildProfile,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";
import { resolvePackagedAppBinary } from "./packaged-app-paths.mjs";

const packageRoot = process.cwd();
const releaseChannel = resolveDesktopReleaseChannel(process.env);
const buildProfile = resolveDesktopBuildProfile(
  process.env.BB_DESKTOP_BUILD_PROFILE,
);
const releaseConfig = createDesktopApplicationIdentity(
  buildProfile,
  releaseChannel,
);
const releaseDir =
  buildProfile === "release"
    ? join(packageRoot, "release")
    : join(packageRoot, releaseConfig.outputDirectory);

function createElectronAppEnv(env) {
  const childEnv = {
    ...env,
    BB_DESKTOP_OPEN_DEVTOOLS: env.BB_DESKTOP_OPEN_DEVTOOLS ?? "1",
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

function createLaunchArguments(env) {
  const userDataDir = env.BB_DESKTOP_USER_DATA_DIR?.trim();
  if (userDataDir === undefined || userDataDir.length === 0) {
    return [];
  }
  return createPackagedAppLaunchArguments({
    platform: process.platform,
    userDataDir,
  });
}

const childEnvironment = createElectronAppEnv(process.env);
if (buildProfile !== "release") {
  for (const key of [
    "BB_DESKTOP_APP_DATA_DIR",
    "BB_DESKTOP_USER_DATA_DIR",
    "BB_DATA_DIR",
    "BB_SERVER_PORT",
    "BB_SERVER_URL",
    "BB_HOST_DAEMON_PORT",
  ]) {
    delete childEnvironment[key];
  }
  childEnvironment.BB_DESKTOP_BUILD_PROFILE = buildProfile;
  if (buildProfile === "lab") {
    for (const key of [
      "BB_LAB_DATA_DIR",
      "BB_LAB_USER_DATA_DIR",
      "BB_LAB_APP_DATA_DIR",
      "BB_LAB_SERVER_PORT",
      "BB_LAB_HOST_DAEMON_PORT",
    ]) {
      delete childEnvironment[key];
    }
  }
}

const child = spawn(
  await resolvePackagedAppBinary({
    executableName: releaseConfig.linuxExecutableName,
    platform: process.platform,
    productName: releaseConfig.applicationName,
    releaseDir,
  }),
  createLaunchArguments(process.env),
  {
    env: childEnvironment,
    stdio: "inherit",
  },
);

await forwardSignalsAndMirrorExit(child);
