export interface DeployOptions {
  build: boolean;
  smoke: boolean;
  replace: boolean;
  force: boolean;
  waitTimeoutMinutes: number;
  reportThreadId: string | null;
  dryRun: boolean;
  help: boolean;
  restartConfigPath: string | null;
}

export interface DeployPaths {
  appPath: string;
  executablePath: string;
  stateDir: string;
  logDir: string;
  stagedPath: string;
  previousPath: string;
  failedPath: string;
  lockPath: string;
  lastResultPath: string;
}

export interface ThreadSummary {
  id: string;
  status: string;
  title?: string | null;
}

export type ThreadListing =
  | { ok: true; threads: ThreadSummary[] }
  | { ok: false; error: string };

export interface ProcessRow {
  pid: number;
  value: string;
}

export interface RestartConfig {
  appPath: string;
  stagedPath: string;
  replace: boolean;
  force: boolean;
  waitTimeoutMs: number;
  pollMs: number;
  settleChecks: number;
  commit?: string | null;
}

export interface RestartEffects {
  log(message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  readBundleVersion(appPath: string): string | null;
  listThreads(): Promise<ThreadListing>;
  health(): Promise<{ launchId: string | null } | null>;
  mainProcess(): number | null;
  quitApp(): Promise<void>;
  swapInBundle(): void;
  restorePreviousBundle(): void;
  openApp(): void;
  waitForHealth(
    previousLaunchId: string | null,
  ): Promise<
    { ok: true; launchId: string | null } | { ok: false; error: string }
  >;
}

export interface RestartResult {
  status: "started" | "succeeded" | "aborted" | "rolled-back" | "failed";
  fromVersion: string | null;
  toVersion: string | null;
  commit: string | null;
  startedAt: string;
  finishedAt: string | null;
  message: string;
}

export const PERSONAL_PROFILE: {
  applicationName: string;
  defaultServerPort: number;
  serverBindHost: string;
};
export const BUSY_THREAD_STATUSES: ReadonlySet<string>;
export const APP_LAUNCH_PATH: string;
export function buildDeployToolEnv(
  sourceEnv: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function buildAppLaunchEnv(
  sourceEnv: Record<string, string | undefined>,
  options?: { sshAuthSock?: string | null },
): Record<string, string>;
export function bundledBbCliPath(appPath: string): string;
export function deployUsage(): string;
export function parseDeployArguments(argv: readonly string[]): DeployOptions;
export function resolveDeployPaths(args?: {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  applicationName?: string;
}): DeployPaths;
export function findBusyThreads<T extends ThreadSummary>(
  threads: readonly T[],
): T[];
export function parseProcessTable(output: string): ProcessRow[];
export function selectBundleProcesses(args: {
  executables: readonly ProcessRow[];
  appPath: string;
}): number[];
export function selectMainProcess(args: {
  commandLines: readonly ProcessRow[];
  executablePath: string;
}): number | null;
export function readProcesses(): {
  executables: ProcessRow[];
  commandLines: ProcessRow[];
};
export function readBundleVersion(appPath: string): string | null;
export function swapInBundle(args: {
  appPath: string;
  stagedPath: string;
  previousPath: string;
}): { hadPrevious: boolean };
export function restorePreviousBundle(args: {
  appPath: string;
  previousPath: string;
  failedPath: string;
}): void;
export function waitForIdleThreads(args: {
  listThreads(): Promise<ThreadListing>;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutMs: number;
  pollMs: number;
  settleChecks: number;
  log(message: string): void;
}): Promise<{ idle: boolean; busy: ThreadSummary[] }>;
export function runRestart(args: {
  config: RestartConfig;
  effects: RestartEffects;
}): Promise<RestartResult>;
