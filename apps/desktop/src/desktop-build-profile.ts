import { homedir } from "node:os";
import { join } from "node:path";
import { DESKTOP_BUILD_PROFILES } from "../scripts/desktop-build-profiles.mjs";
import {
  assertLabRuntimeConfig,
  createExpectedLabRuntimeConfig,
} from "../scripts/lab-runtime-config.mjs";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
} from "@bb/config/app-surface";
import { resolveIsolatedProfilePath } from "../scripts/desktop-profile-paths.mjs";
import {
  createDesktopApplicationIdentity as createApplicationIdentity,
  resolveDesktopBuildProfile,
  resolveDesktopReleaseChannel,
  type DesktopBuildProfile,
} from "../scripts/desktop-release-channel.mjs";

export type DesktopApplicationIdentity = ReturnType<
  typeof createApplicationIdentity
>;

export const DESKTOP_BUILD_PROFILE = resolveDesktopBuildProfile(
  process.env.BB_DESKTOP_BUILD_PROFILE,
);
export const DESKTOP_RELEASE_CHANNEL = resolveDesktopReleaseChannel(
  process.env,
);

export function createDesktopApplicationIdentity(
  profile: DesktopBuildProfile,
  releaseChannel: "latest" | "nightly",
): DesktopApplicationIdentity {
  return createApplicationIdentity(profile, releaseChannel);
}

export function createDesktopProfileEnvironment(args: {
  env: NodeJS.ProcessEnv;
  expectedLabRuntimeConfig?: ReturnType<typeof createExpectedLabRuntimeConfig>;
  homeDir?: string;
  profile: DesktopBuildProfile;
}): NodeJS.ProcessEnv {
  const env = { ...args.env };
  const homeDir = args.homeDir ?? homedir();
  if (args.profile === "personal") {
    env.BB_DESKTOP_APP_DATA_DIR = resolveIsolatedProfilePath({
      path:
        env.BB_PERSONAL_APP_DATA_DIR?.trim() ||
        join(homeDir, DESKTOP_BUILD_PROFILES.personal.defaultAppDataDirectory),
      homeDir,
    });
    env.BB_DESKTOP_USER_DATA_DIR = resolveIsolatedProfilePath({
      path:
        env.BB_PERSONAL_USER_DATA_DIR?.trim() ||
        join(homeDir, DESKTOP_BUILD_PROFILES.personal.defaultUserDataDirectory),
      homeDir,
    });
    delete env.BB_PERSONAL_APP_DATA_DIR;
    delete env.BB_PERSONAL_USER_DATA_DIR;
    return env;
  }
  if (args.profile !== "lab") {
    return env;
  }

  const resolvedConfig = createExpectedLabRuntimeConfig({ env, homeDir });
  if (args.expectedLabRuntimeConfig !== undefined) {
    assertLabRuntimeConfig(
      {
        BB_DATA_DIR: resolvedConfig.dataDir,
        BB_DESKTOP_APP_DATA_DIR: resolvedConfig.appDataDir,
        BB_DESKTOP_USER_DATA_DIR: resolvedConfig.userDataDir,
        BB_SERVER_BIND_HOST: resolvedConfig.bindHost,
        BB_SERVER_PORT: resolvedConfig.serverPort,
        BB_HOST_DAEMON_PORT: resolvedConfig.daemonPort,
      },
      args.expectedLabRuntimeConfig,
    );
  }
  env.BB_DATA_DIR = resolvedConfig.dataDir;
  env.BB_DESKTOP_APP_DATA_DIR = resolvedConfig.appDataDir;
  env.BB_DESKTOP_USER_DATA_DIR = resolvedConfig.userDataDir;
  env.BB_SERVER_PORT = resolvedConfig.serverPort;
  env.BB_HOST_DAEMON_PORT = resolvedConfig.daemonPort;
  env.BB_SERVER_BIND_HOST = resolvedConfig.bindHost;
  delete env.BB_DESKTOP_LAB_EXPECTED_CONFIG;
  delete env.BB_DESKTOP_LAB_SMOKE_MODE;
  delete env.BB_LAB_DATA_DIR;
  delete env.BB_LAB_USER_DATA_DIR;
  delete env.BB_LAB_APP_DATA_DIR;
  delete env.BB_LAB_SERVER_PORT;
  delete env.BB_LAB_HOST_DAEMON_PORT;
  delete env.BB_PERSONAL_APP_DATA_DIR;
  delete env.BB_PERSONAL_USER_DATA_DIR;
  env.BB_TELEMETRY = "false";
  for (const key of [
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
    "BB_INFERENCE",
    "BB_INFERENCE_FALLBACK",
    "BB_TRANSCRIPTION",
    "BB_POSTHOG_API_KEY",
    "BB_HOST_DAEMON_AUTO_UPDATE",
    "BB_HOST_DAEMON_SUPERVISED",
    "BB_APP_UPDATE_MODE",
    "BB_SERVER_LAUNCH_ID",
    "BB_APP_VERSION",
    "BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD",
    "BB_APP_NPM_PREFIX",
    "BB_BRIDGE_DIR",
    "BB_LOG_LEVEL",
    "BB_MARKETPLACE_URL",
    "BB_DEV_APP_PORT",
    "BB_FF_PLACEHOLDER",
    "BB_FF_TIMELINE_WINDOW_EVENT_BUDGET",
    "BB_PROVIDER_BRIDGE_RECORD_DIR",
    "XDG_CONFIG_HOME",
  ]) {
    delete env[key];
  }
  env[APP_SURFACE_ENV_NAME] = APP_SURFACE_DESKTOP;
  for (const key of [
    "BB_ACCOUNT_POOL_PARENT_TOKEN",
    "BB_ACCOUNT_POOL_PARENT_URL",
    "BB_APP_URL",
    "BB_DATA_DIR_OVERRIDE",
    "BB_DESKTOP_APP_URL",
    "BB_EXTERNAL_URL",
    "BB_SERVER_URL",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("BB_DEV_") ||
      key.startsWith("BB_WORKTREE_") ||
      key.startsWith("BB_ENVIRONMENT_") ||
      key.startsWith("BB_LAB_")
    ) {
      delete env[key];
    }
  }
  return env;
}
