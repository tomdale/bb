import type {
  DesktopReleaseChannel,
  DesktopUpdateMetadataFileNames,
} from "./desktop-release-channel.mjs";

export type DesktopBuildProfile = "release" | "personal" | "lab";

export interface DesktopBuildProfileConfig {
  appId: string;
  applicationName: string;
  artifactName: string;
  iconFileName: string;
  linuxExecutableName: string;
  macIconPath: string;
  outputDirectory: string;
  defaultDataDirectory: string;
  defaultAppDataDirectory: string;
  defaultUserDataDirectory: string;
  defaultServerPort: number;
  defaultHostDaemonPort: number;
  serverBindHost: string;
  updatesEnabled: boolean;
}

export const DESKTOP_BUILD_PROFILES: Record<
  "personal" | "lab",
  DesktopBuildProfileConfig
>;

export interface DesktopApplicationIdentity {
  appId: string;
  applicationName: string;
  artifactName: string;
  iconFileName: string;
  linuxExecutableName: string;
  macIconPath: string;
  outputDirectory?: string;
  publish: Array<{
    channel: DesktopReleaseChannel;
    provider: "generic";
    url: string;
  }>;
  releaseTag?: string;
  updateMetadataFileNames?: DesktopUpdateMetadataFileNames;
  updatesEnabled: boolean;
  windowsInstallName?: string;
}

export function resolveDesktopBuildProfile(
  value: string | undefined,
): DesktopBuildProfile;

export function createDesktopApplicationIdentity(
  profile: DesktopBuildProfile,
  releaseChannel: DesktopReleaseChannel,
): DesktopApplicationIdentity;
