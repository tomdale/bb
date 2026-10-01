import { DESKTOP_BUILD_PROFILES } from "./desktop-build-profiles.mjs";

const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

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

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      artifactName: "bb-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      linuxExecutableName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      publish: [
        {
          channel: "nightly",
          provider: "generic",
          url: "https://github.com/get-bb/bb/releases/download/desktop-nightly/",
        },
      ],
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
      },
    };
  }

  return {
    appId: "dev.bb.desktop",
    applicationName: "bb",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxExecutableName: "bb",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    publish: [
      {
        channel: "latest",
        provider: "generic",
        url: "https://github.com/get-bb/bb/releases/download/desktop-latest/",
      },
    ],
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
    },
  };
}

export function createDesktopApplicationIdentity(profile, releaseChannel) {
  if (profile === "release") {
    return {
      ...createDesktopReleaseConfig(releaseChannel),
      updatesEnabled: true,
    };
  }
  return {
    ...DESKTOP_BUILD_PROFILES[profile],
    publish: [],
    updatesEnabled: false,
  };
}

export function createDesktopUpdateReleaseBaseUrl(releaseTag) {
  return `https://github.com/get-bb/bb/releases/download/${releaseTag}/`;
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }

  throw new Error(
    `Desktop builds support darwin and linux only, got ${nodePlatform}.`,
  );
}
