export type DesktopReleaseChannel = "latest" | "nightly";
export type DesktopBuildPlatform = "macos" | "linux";
export type DesktopBuildProfile = "release" | "personal" | "lab";

export interface DesktopUpdateMetadataFileNames {
  linux: "latest-linux.yml" | "nightly-linux.yml";
  macos: "latest-mac.yml" | "nightly-mac.yml";
}

export interface DesktopReleaseConfig {
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
  releaseTag: string;
  updateMetadataFileNames: DesktopUpdateMetadataFileNames;
}

export function resolveDesktopReleaseChannel(
  env: NodeJS.ProcessEnv,
): DesktopReleaseChannel;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function resolveDesktopBuildProfile(
  value: string | undefined,
): DesktopBuildProfile;

export interface DesktopApplicationIdentity {
  appId: string;
  applicationName: string;
  artifactName: string;
  iconFileName: string;
  linuxExecutableName: string;
  macIconPath: string;
  outputDirectory?: string;
  publish: DesktopReleaseConfig["publish"];
  releaseTag?: string;
  updateMetadataFileNames?: DesktopUpdateMetadataFileNames;
  updatesEnabled: boolean;
}

export function createDesktopApplicationIdentity(
  profile: DesktopBuildProfile,
  releaseChannel: DesktopReleaseChannel,
): DesktopApplicationIdentity;

export function createDesktopReleaseConfig(
  channel: DesktopReleaseChannel,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  releaseTag: DesktopReleaseConfig["releaseTag"],
): string;
