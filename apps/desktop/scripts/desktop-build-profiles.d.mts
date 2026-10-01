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
