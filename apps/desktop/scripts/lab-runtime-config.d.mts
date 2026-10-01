export interface ExpectedLabRuntimeConfig {
  dataDir: string;
  appDataDir: string;
  userDataDir: string;
  bindHost: string;
  serverPort: string;
  daemonPort: string;
}

export function createExpectedLabRuntimeConfig(args: {
  env: NodeJS.ProcessEnv;
  homeDir?: string;
}): ExpectedLabRuntimeConfig;

export function parseExpectedLabRuntimeConfig(args: {
  serializedExpected: string;
  homeDir?: string;
}): ExpectedLabRuntimeConfig;

export function assertLabRuntimeConfig(
  actual: NodeJS.ProcessEnv,
  expected: ExpectedLabRuntimeConfig,
): void;
