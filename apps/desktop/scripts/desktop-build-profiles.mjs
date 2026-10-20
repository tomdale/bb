import {
  createDesktopReleaseConfig,
  createDesktopUpdateReleaseBaseUrl,
} from "./desktop-release-channel.mjs";

export const DESKTOP_BUILD_PROFILES = {
  personal: {
    appId: "com.tomdale.bb.personal",
    applicationName: "bb Personal",
    artifactName: "bb-personal-${version}-${arch}.${ext}",
    iconFileName: "icon-personal.png",
    linuxExecutableName: "bb-personal",
    macIconPath: "assets/icon-personal.icns",
    outputDirectory: "release/personal",
    defaultDataDirectory: ".bb",
    defaultAppDataDirectory: ".bb-personal-electron",
    defaultUserDataDirectory: ".bb-personal-desktop",
    defaultServerPort: 38_886,
    defaultHostDaemonPort: 38_887,
    serverBindHost: "127.0.0.1",
    updatesEnabled: false,
  },
  lab: {
    appId: "com.tomdale.bb.lab",
    applicationName: "bb Lab",
    artifactName: "bb-lab-${version}-${arch}.${ext}",
    iconFileName: "icon-lab.png",
    linuxExecutableName: "bb-lab",
    macIconPath: "assets/icon-lab.icns",
    outputDirectory: "release/lab",
    defaultDataDirectory: ".bb-lab",
    defaultAppDataDirectory: ".bb-lab-electron",
    defaultUserDataDirectory: ".bb-lab-desktop",
    defaultServerPort: 38_890,
    defaultHostDaemonPort: 38_891,
    serverBindHost: "127.0.0.1",
    updatesEnabled: false,
  },
};

export function resolveDesktopBuildProfile(value) {
  if (value === undefined || value === "release") {
    return "release";
  }
  if (value === "personal" || value === "lab") {
    return value;
  }
  throw new Error(
    `Desktop build profile must be release, personal, or lab, got ${value}.`,
  );
}

export function createDesktopApplicationIdentity(profile, releaseChannel) {
  if (profile === "release") {
    const releaseConfig = createDesktopReleaseConfig(releaseChannel);
    return {
      ...releaseConfig,
      publish: [
        {
          channel: releaseChannel,
          provider: "generic",
          url: createDesktopUpdateReleaseBaseUrl(releaseConfig.releaseTag),
        },
      ],
      updatesEnabled: true,
    };
  }
  return {
    ...DESKTOP_BUILD_PROFILES[profile],
    publish: [],
    updatesEnabled: false,
  };
}
