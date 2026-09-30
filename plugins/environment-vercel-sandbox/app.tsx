import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useRpc,
  useSdk,
  type JsonValue,
  type PluginMachineProviderInputsChange,
  type PluginMachineProviderInputsProps,
  type PluginRpcResult,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
} from "@/components/ui/option-display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { vercelRpcContract } from "./rpc.js";
import { PROVIDER_ID } from "./provider-id.js";

type Contract = typeof vercelRpcContract;
type LaunchOptions = PluginRpcResult<Contract["launch.options"]>;
type AccountStatus = PluginRpcResult<Contract["account.inspect"]>;
type MachineStatus = PluginRpcResult<Contract["machine.inspect"]>["values"];

type LaunchInputs = { vcpus?: number; timeoutMinutes?: number };

type Load<T> =
  | { status: "pending" }
  | { status: "ready"; data: T }
  | { status: "error" };

const PREFERRED_VCPUS = [1, 2, 4, 8, 16, 32] as const;
const MAX_LISTED_VCPU_CHOICES = 8;
const TIMEOUT_LADDER_MINUTES = [15, 30, 45, 60, 120, 240, 480, 1440] as const;
const HOBBY_MAX_VCPUS = 4;
const PRO_MAX_VCPUS = 8;
const HOBBY_MAX_TIMEOUT_MINUTES = 45;
const WARNING_REMAINING_MS = 10 * 60_000;
const TICK_MS = 30_000;

const DATA_LOSS_NOTE =
  "The sandbox stops for good at its time limit. BB can't extend, pause, or restore it, so uncommitted files are lost. Push work you want to keep.";
const PLAN_NOTE =
  "Choices are Vercel maximums. BB can't see your plan; a launch above its limits fails when the sandbox starts.";

function isPlainObject(
  value: JsonValue | null,
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function readLaunchInputs(value: JsonValue | null): LaunchInputs | null {
  if (value === null) return {};
  if (!isPlainObject(value)) return null;
  const inputs: LaunchInputs = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "vcpus" && isWholeNumber(entry)) inputs.vcpus = entry;
    else if (key === "timeoutMinutes" && isWholeNumber(entry))
      inputs.timeoutMinutes = entry;
    else return null;
  }
  return inputs;
}

function launchInputsValue(inputs: LaunchInputs): JsonValue {
  return {
    ...(inputs.vcpus === undefined ? {} : { vcpus: inputs.vcpus }),
    ...(inputs.timeoutMinutes === undefined
      ? {}
      : { timeoutMinutes: inputs.timeoutMinutes }),
  };
}

function outOfRangeReason(
  inputs: LaunchInputs,
  limits: LaunchOptions["limits"],
): string | null {
  if (
    inputs.vcpus !== undefined &&
    !limits.allowedVcpus.includes(inputs.vcpus)
  ) {
    return `The saved choice of ${inputs.vcpus} vCPU isn't available. Vercel allows ${limits.allowedVcpus.join(", ")} vCPUs; choose another size.`;
  }
  if (
    inputs.timeoutMinutes !== undefined &&
    (inputs.timeoutMinutes < limits.minTimeoutMinutes ||
      inputs.timeoutMinutes > limits.maxTimeoutMinutes)
  ) {
    return `The saved time limit of ${formatMinutes(inputs.timeoutMinutes).full} is outside Vercel's ${formatMinutes(limits.minTimeoutMinutes).full}–${formatMinutes(limits.maxTimeoutMinutes).full} range. Choose another.`;
  }
  return null;
}

export function formatMinutes(minutes: number): {
  full: string;
  compact: string;
  spoken: string;
} {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const plural = (count: number, unit: string) =>
    `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (hours === 0) {
    return {
      full: `${minutes} min`,
      compact: `${minutes}m`,
      spoken: plural(minutes, "minute"),
    };
  }
  if (rest === 0) {
    return {
      full: `${hours} h`,
      compact: `${hours}h`,
      spoken: plural(hours, "hour"),
    };
  }
  return {
    full: `${hours} h ${rest} min`,
    compact: `${hours}h${rest}m`,
    spoken: `${plural(hours, "hour")} ${plural(rest, "minute")}`,
  };
}

function formatMemory(memoryMiB: number): string {
  const gib = memoryMiB / 1024;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

function sizeLabel(vcpus: number, memoryMiB: number): string {
  return `${vcpus} vCPU · ${formatMemory(memoryMiB)}`;
}

function isAllowedVcpuCount(vcpus: number): boolean {
  return vcpus === 1 || vcpus % 2 === 0;
}

function vcpuPlanTag(vcpus: number): string | null {
  if (vcpus <= HOBBY_MAX_VCPUS) return null;
  return vcpus <= PRO_MAX_VCPUS ? "Pro+" : "Enterprise";
}

function timeoutPlanTag(minutes: number): string | null {
  return minutes <= HOBBY_MAX_TIMEOUT_MINUTES ? null : "Pro+";
}

function vcpuChoices(
  options: LaunchOptions,
  current: number | undefined,
): number[] {
  const allowed = [...new Set(options.limits.allowedVcpus)]
    .filter(isAllowedVcpuCount)
    .sort((left, right) => left - right);
  if (allowed.length <= MAX_LISTED_VCPU_CHOICES) return allowed;
  const listed = new Set<number>(PREFERRED_VCPUS);
  listed.add(options.defaultInputs.vcpus);
  if (current !== undefined) listed.add(current);
  return allowed.filter((candidate) => listed.has(candidate));
}

function choiceList(
  ladder: readonly number[],
  min: number,
  max: number,
  extra: readonly (number | undefined)[],
): number[] {
  const inRange = (candidate: number) => candidate >= min && candidate <= max;
  const values = new Set(ladder.filter(inRange));
  for (const candidate of extra) {
    if (candidate !== undefined && inRange(candidate)) values.add(candidate);
  }
  return [...values].sort((left, right) => left - right);
}

function useRpcLoad<T>(request: () => Promise<T>): {
  state: Load<T>;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Load<T>>({ status: "pending" });
  useEffect(() => {
    let active = true;
    request().then(
      (data) => {
        if (active) setState({ status: "ready", data });
      },
      () => {
        if (active) setState({ status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [request, attempt]);
  const retry = useCallback(() => {
    setState({ status: "pending" });
    setAttempt((current) => current + 1);
  }, []);
  return { state, retry };
}

function useLaunchOptions() {
  const rpc = useRpc<Contract>();
  const request = useCallback(() => rpc.call("launch.options", {}), [rpc]);
  return useRpcLoad(request);
}

function MenuChoice({
  label,
  tag,
  selected,
  onSelect,
}: {
  label: string;
  tag: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={selected}
      onSelect={onSelect}
      className="flex items-center justify-between gap-3"
    >
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      {tag === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>
      )}
      <Icon
        name="Check"
        className={cn(
          COARSE_POINTER_ICON_SIZE_CLASS,
          "shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </DropdownMenuItem>
  );
}

function MenuNote({
  tone,
  children,
}: {
  tone: "muted" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex max-w-72 gap-2 px-2 py-1.5 text-xs leading-relaxed",
        tone === "warning" ? "text-warning-text" : "text-muted-foreground",
      )}
    >
      <Icon
        name={tone === "warning" ? "AlertTriangle" : "Info"}
        className={cn(
          "mt-0.5 shrink-0",
          COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
        )}
      />
      <span className="min-w-0 whitespace-normal">{children}</span>
    </div>
  );
}

function launchChange(
  inputs: LaunchInputs | null,
  options: Load<LaunchOptions>,
): PluginMachineProviderInputsChange {
  if (inputs === null) {
    return {
      status: "blocked",
      reason:
        "The saved Vercel sandbox options are invalid. Choose new ones from the sandbox menu.",
    };
  }
  if (inputs.vcpus !== undefined && !isAllowedVcpuCount(inputs.vcpus)) {
    return {
      status: "blocked",
      reason: `The saved choice of ${inputs.vcpus} vCPU isn't available. Vercel accepts 1 or an even number of vCPUs; choose another size.`,
    };
  }
  if (options.status === "ready") {
    const reason = outOfRangeReason(inputs, options.data.limits);
    if (reason !== null) return { status: "blocked", reason };
  }
  return { status: "ready", value: launchInputsValue(inputs) };
}

function VercelMachineInputsControl({
  value,
  onChange,
}: PluginMachineProviderInputsProps) {
  const { state: options, retry } = useLaunchOptions();
  const inputs = readLaunchInputs(value);
  const change = launchChange(inputs, options);
  useEffect(() => {
    onChange(launchChange(readLaunchInputs(value), options));
  }, [value, options, onChange]);

  const blockedReason = change.status === "blocked" ? change.reason : null;
  const loaded = options.status === "ready" ? options.data : null;
  const valid = inputs !== null && blockedReason === null ? inputs : {};
  const vcpus = valid.vcpus ?? loaded?.defaultInputs.vcpus;
  const timeoutMinutes =
    valid.timeoutMinutes ?? loaded?.defaultInputs.timeoutMinutes;

  const choose = (next: LaunchInputs) => {
    const merged = {
      vcpus: next.vcpus ?? vcpus,
      timeoutMinutes: next.timeoutMinutes ?? timeoutMinutes,
    };
    onChange({ status: "ready", value: launchInputsValue(merged) });
  };

  let fullLabel: string;
  let compactLabel: string;
  let accessibleLabel: string;
  if (blockedReason !== null) {
    fullLabel = "Choose sandbox size";
    compactLabel = "Choose size";
    accessibleLabel = "Vercel sandbox: choose new options";
  } else if (vcpus !== undefined && timeoutMinutes !== undefined) {
    const duration = formatMinutes(timeoutMinutes);
    fullLabel = `${vcpus} vCPU · ${duration.full}`;
    compactLabel = `${vcpus} · ${duration.compact}`;
    accessibleLabel = `Vercel sandbox: ${vcpus} vCPU, stops after ${duration.spoken}`;
  } else {
    fullLabel = "Vercel sandbox";
    compactLabel = "Vercel";
    accessibleLabel =
      options.status === "error"
        ? "Vercel sandbox: options unavailable"
        : "Vercel sandbox: loading options";
  }
  const showAlert = blockedReason !== null || options.status === "error";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={accessibleLabel}
          data-promptbox-shrinkable-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            showAlert ? "text-warning-text" : OPTION_MUTED_CLASS_NAME,
          )}
        >
          {showAlert ? (
            <Icon
              name="AlertTriangle"
              className={cn("shrink-0", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
            />
          ) : options.status === "pending" && vcpus === undefined ? (
            <Icon
              name="Spinner"
              className={cn(
                "shrink-0 animate-spin",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
          ) : null}
          <span className="min-w-0 truncate" data-promptbox-full-label="">
            {fullLabel}
          </span>
          <span className="min-w-0 truncate" data-promptbox-compact-label="">
            {compactLabel}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "shrink-0 text-muted-foreground",
              COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        mobileTitle="Vercel sandbox"
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
      >
        {blockedReason === null ? null : (
          <MenuNote tone="warning">{blockedReason}</MenuNote>
        )}
        {options.status === "pending" ? (
          <p
            role="status"
            className="px-2 py-1.5 text-xs text-muted-foreground"
          >
            Loading Vercel launch options…
          </p>
        ) : null}
        {options.status === "error" ? (
          <>
            <p role="alert" className="px-2 py-1.5 text-xs text-warning-text">
              Couldn't load Vercel launch options. New sandboxes use the
              defaults in plugin settings.
            </p>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                retry();
              }}
              className="text-xs"
            >
              <Icon name="ArrowReloadHorizontal" className="size-3.5" />
              Retry
            </DropdownMenuItem>
          </>
        ) : null}
        {loaded === null ? null : (
          <>
            <DropdownMenuLabel>vCPU</DropdownMenuLabel>
            {vcpuChoices(loaded, valid.vcpus).map((candidate) => (
              <MenuChoice
                key={candidate}
                label={`${sizeLabel(candidate, candidate * loaded.memoryMiBPerVcpu)}${candidate === loaded.defaultInputs.vcpus ? " (default)" : ""}`}
                tag={vcpuPlanTag(candidate)}
                selected={blockedReason === null && candidate === vcpus}
                onSelect={() => choose({ vcpus: candidate })}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Stops after</DropdownMenuLabel>
            {choiceList(
              TIMEOUT_LADDER_MINUTES,
              loaded.limits.minTimeoutMinutes,
              loaded.limits.maxTimeoutMinutes,
              [loaded.defaultInputs.timeoutMinutes, inputs?.timeoutMinutes],
            ).map((candidate) => (
              <MenuChoice
                key={candidate}
                label={`${formatMinutes(candidate).full}${candidate === loaded.defaultInputs.timeoutMinutes ? " (default)" : ""}`}
                tag={timeoutPlanTag(candidate)}
                selected={
                  blockedReason === null && candidate === timeoutMinutes
                }
                onSelect={() => choose({ timeoutMinutes: candidate })}
              />
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <MenuNote tone="warning">{DATA_LOSS_NOTE}</MenuNote>
        <MenuNote tone="muted">{PLAN_NOTE}</MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsHeading({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {action}
    </div>
  );
}

function ConnectionStatus({ state }: { state: Load<AccountStatus> }) {
  if (state.status === "pending") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <Icon name="Spinner" className="size-3.5 animate-spin" />
        Checking the Vercel connection…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 text-xs text-destructive-text"
      >
        <Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" />
        Couldn't check the Vercel connection. Try again in a moment.
      </p>
    );
  }
  const account = state.data;
  if (!account.available) {
    return (
      <p
        role="alert"
        className="flex items-start gap-2 text-xs text-destructive-text"
      >
        <Icon name="AlertCircle" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{account.message}</span>
      </p>
    );
  }
  const scope = [account.teamId, account.projectId].filter(
    (entry): entry is string => entry !== null,
  );
  return (
    <div role="status" className="space-y-1 text-xs">
      <p className="flex items-start gap-2 text-foreground">
        <Icon
          name="CircleCheck"
          className="mt-0.5 size-3.5 shrink-0 text-success"
        />
        <span className="min-w-0 break-words">
          The token can list sandboxes
          {scope.length === 0 ? "" : ` in ${scope.join(" / ")}`}.
        </span>
      </p>
      <p className="pl-5.5 leading-relaxed text-muted-foreground">
        This doesn't confirm your plan's sandbox limits. Vercel checks those
        when a sandbox starts.
      </p>
    </div>
  );
}

function VercelSettingsSection() {
  const rpc = useRpc<Contract>();
  const inspectAccount = useCallback(
    () => rpc.call("account.inspect", {}),
    [rpc],
  );
  const account = useRpcLoad(inspectAccount);
  const { state: options, retry: retryOptions } = useLaunchOptions();
  const loaded = options.status === "ready" ? options.data : null;
  return (
    <div className="w-full min-w-0 space-y-5">
      <section className="space-y-2">
        <SettingsHeading
          title="Connection"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={account.state.status === "pending"}
              onClick={account.retry}
            >
              Check again
            </Button>
          }
        />
        <ConnectionStatus state={account.state} />
      </section>

      <section className="space-y-2">
        <SettingsHeading title="New sandboxes" />
        {options.status === "pending" ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading launch defaults…
          </p>
        ) : null}
        {options.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs text-destructive-text">
              Couldn't load launch defaults.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={retryOptions}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {loaded === null ? null : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Default size</dt>
            <dd className="text-foreground">
              {sizeLabel(
                loaded.defaultInputs.vcpus,
                loaded.defaultInputs.vcpus * loaded.memoryMiBPerVcpu,
              )}
            </dd>
            <dt className="text-muted-foreground">Stops after</dt>
            <dd className="text-foreground">
              {formatMinutes(loaded.defaultInputs.timeoutMinutes).full}
            </dd>
            <dt className="text-muted-foreground">Vercel maximums</dt>
            <dd className="text-foreground">
              {loaded.limits.minVcpus}–{loaded.limits.maxVcpus} vCPU,{" "}
              {formatMinutes(loaded.limits.minTimeoutMinutes).full}–
              {formatMinutes(loaded.limits.maxTimeoutMinutes).full}
            </dd>
            <dt className="text-muted-foreground">Image</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">
              {loaded.image}
            </dd>
          </dl>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Your plan may allow less than Vercel's maximums (Hobby: 4 vCPU and 45
          minutes). Change the defaults in the fields above; the composer can
          override them per thread.
        </p>
      </section>

      <section className="space-y-2">
        <SettingsHeading title="Data and billing" />
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
          <li>
            Each sandbox is a disposable BB machine. It stops for good at its
            time limit; BB can't extend, pause, snapshot, or restore it.
          </li>
          <li>
            Uncommitted files are lost when the sandbox stops, when its machine
            is removed, or when its thread is archived. Push work you want to
            keep.
          </li>
          <li>
            Vercel bills your team while a sandbox runs, whether or not the
            agent is working. Remove machines you're done with.
          </li>
        </ul>
      </section>
    </div>
  );
}

type HostResolution =
  | { kind: "pending" }
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "creating"; hostId: string }
  | { kind: "removing"; hostId: string }
  | { kind: "removed"; hostId: string }
  | { kind: "active"; hostId: string };

function useVercelHost(threadId: string, refreshKey: number): HostResolution {
  const sdk = useSdk();
  const [resolution, setResolution] = useState<{
    threadId: string;
    value: HostResolution;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const current =
    resolution?.threadId === threadId
      ? resolution.value
      : { kind: "pending" as const };
  const settled = current.kind === "none" || current.kind === "removed";
  const polling =
    current.kind === "waiting" ||
    current.kind === "creating" ||
    current.kind === "removing";
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [polling]);
  useEffect(() => {
    if (settled) return;
    const controller = new AbortController();
    const resolve = async (): Promise<HostResolution> => {
      const thread = await sdk.threads.get({
        threadId,
        signal: controller.signal,
      });
      if (thread.environmentId === null) return { kind: "waiting" };
      const environment = await sdk.environments.get({
        environmentId: thread.environmentId,
        signal: controller.signal,
      });
      const host = await sdk.hosts.get({
        hostId: environment.hostId,
        signal: controller.signal,
      });
      if (host.machineProviderId !== PROVIDER_ID) return { kind: "none" };
      switch (host.lifecycle.phase) {
        case "creating":
          return { kind: "creating", hostId: host.id };
        case "removing":
          return { kind: "removing", hostId: host.id };
        case "destroyed":
          return { kind: "removed", hostId: host.id };
        default:
          return { kind: "active", hostId: host.id };
      }
    };
    resolve().then(
      (value) => {
        if (!controller.signal.aborted) setResolution({ threadId, value });
      },
      () => {
        if (!controller.signal.aborted)
          setResolution({ threadId, value: { kind: "none" } });
      },
    );
    return () => controller.abort();
  }, [sdk, threadId, tick, refreshKey, settled]);
  return current;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function formatRemaining(ms: number): { short: string; spoken: string } {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1)
    return { short: "<1m left", spoken: "less than a minute left" };
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return {
      short: `${minutes}m left`,
      spoken: `${formatMinutes(minutes).spoken} left`,
    };
  }
  return {
    short: rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`,
    spoken: `${formatMinutes(minutes).spoken} left`,
  };
}

const REPORTED_STOP_STATES = new Set<MachineStatus["state"]>([
  "stopped",
  "failed",
  "aborted",
]);
const DEADLINE_OBSERVATION_DELAY_MS = 1_000;

type ExpiryView = {
  tone: "muted" | "warning" | "destructive";
  label: string;
  spoken: string;
  detail: string;
  final: boolean;
};

function expiryView(
  resolution: HostResolution,
  inspection: Load<MachineStatus>,
  now: number,
): ExpiryView | null {
  if (resolution.kind === "creating") {
    return {
      tone: "muted",
      label: "Starting",
      spoken: "starting",
      detail: `The sandbox is starting. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  if (resolution.kind === "removing") {
    return {
      tone: "warning",
      label: "Removing",
      spoken: "being removed",
      detail:
        "BB is removing this sandbox machine. Uncommitted files will be lost.",
      final: false,
    };
  }
  if (resolution.kind === "removed") {
    return {
      tone: "destructive",
      label: "Removed",
      spoken: "removed",
      detail:
        "BB removed this sandbox machine. It can't be restored; start a new thread to continue.",
      final: true,
    };
  }
  if (resolution.kind !== "active") return null;
  if (inspection.status === "pending") {
    return {
      tone: "muted",
      label: "Sandbox",
      spoken: "checking status",
      detail: "Checking the sandbox's time limit…",
      final: false,
    };
  }
  if (inspection.status === "error") {
    return {
      tone: "warning",
      label: "Sandbox",
      spoken: "status unavailable",
      detail: `Couldn't read the sandbox's time limit. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  const machine = inspection.data;
  if (machine.computeEnded) {
    return {
      tone: "destructive",
      label: "Stopped",
      spoken: "stopped",
      detail:
        "Vercel reports this sandbox's session stopped. BB keeps no snapshot, so its uncommitted files can't be recovered; start a new thread to continue.",
      final: true,
    };
  }
  if (REPORTED_STOP_STATES.has(machine.state)) {
    const state = machine.state;
    return {
      tone: "warning",
      label: `${state.charAt(0).toUpperCase()}${state.slice(1)}?`,
      spoken: `Vercel reports ${state}, stop unconfirmed`,
      detail: `Vercel reports this sandbox as ${state}, but hasn't confirmed it stopped. It may still be running; BB can't tell whether its files are still there.`,
      final: false,
    };
  }
  if (machine.state === "missing") {
    return {
      tone: "warning",
      label: "Unknown",
      spoken: "status unknown",
      detail:
        "Vercel can't find this sandbox right now. It may still be running while Vercel updates its records, or it may have stopped. BB can't tell whether its files are still there.",
      final: false,
    };
  }
  if (machine.state === "pending") {
    return {
      tone: "muted",
      label: "Starting",
      spoken: "starting",
      detail: `The sandbox is starting. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  if (machine.state === "stopping" || machine.state === "snapshotting") {
    return {
      tone: "warning",
      label: "Stopping",
      spoken: "stopping",
      detail:
        "The sandbox is stopping. Uncommitted files will be lost when it stops.",
      final: false,
    };
  }
  if (machine.expiresAt !== null && machine.expiresAt <= now) {
    return {
      tone: "warning",
      label: "Time limit reached",
      spoken: "time limit reached, awaiting Vercel status",
      detail:
        "The time limit has passed. Waiting for Vercel to report the sandbox's state; uncommitted files will be lost when it stops.",
      final: false,
    };
  }
  if (machine.expiresAt === null) {
    return {
      tone: "muted",
      label: "Running",
      spoken: "running",
      detail: `Vercel didn't report a stop time. ${DATA_LOSS_NOTE}`,
      final: false,
    };
  }
  const remainingMs = machine.expiresAt - now;
  const remaining = formatRemaining(remainingMs);
  const stopsAt = new Date(machine.expiresAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    tone: remainingMs <= WARNING_REMAINING_MS ? "warning" : "muted",
    label: remaining.short,
    spoken: remaining.spoken,
    detail: `Stops at ${stopsAt}. BB can't extend, pause, or save it. Commit and push work you want to keep.`,
    final: false,
  };
}

function VercelExpiryIndicator({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const rpc = useRpc<Contract>();
  const [refreshKey, setRefreshKey] = useState(0);
  const resolution = useVercelHost(threadId, refreshKey);
  const hostId = resolution.kind === "active" ? resolution.hostId : null;
  const [observeKey, setObserveKey] = useState(0);
  const [inspection, setInspection] = useState<{
    hostId: string;
    observedAt: number;
    value: Load<MachineStatus>;
    summary: string | null;
  } | null>(null);
  useEffect(() => {
    if (hostId === null) return;
    let active = true;
    rpc.call("machine.inspect", { hostId }).then(
      (result) => {
        if (!active) return;
        setInspection({
          hostId,
          observedAt: Date.now(),
          value: { status: "ready", data: result.values },
          summary: result.summary,
        });
      },
      () => {
        if (!active) return;
        setInspection({
          hostId,
          observedAt: Date.now(),
          value: { status: "error" },
          summary: null,
        });
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, hostId, refreshKey, observeKey]);
  const current =
    inspection !== null && inspection.hostId === hostId ? inspection : null;
  const machine: Load<MachineStatus> = current?.value ?? { status: "pending" };
  const deadline =
    machine.status === "ready" && !machine.data.computeEnded
      ? machine.data.expiresAt
      : null;
  const observedAt = current?.observedAt ?? null;
  useEffect(() => {
    if (deadline === null || observedAt === null || observedAt > deadline)
      return;
    const timer = setTimeout(
      () => setObserveKey((value) => value + 1),
      Math.max(0, deadline - Date.now()) + DEADLINE_OBSERVATION_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [deadline, observedAt]);
  const counting =
    machine.status === "ready" &&
    machine.data.state === "running" &&
    !machine.data.computeEnded &&
    machine.data.expiresAt !== null;
  const tickNow = useNow(counting);
  const now = Math.max(tickNow, inspection?.observedAt ?? 0);
  const view = expiryView(resolution, machine, now);
  if (view === null) return null;
  const refresh = () => setRefreshKey((current) => current + 1);
  const toneClass =
    view.tone === "destructive"
      ? "text-destructive-text"
      : view.tone === "warning"
        ? "text-warning-text"
        : OPTION_MUTED_CLASS_NAME;
  const details =
    machine.status === "ready" && !view.final
      ? {
          size: sizeLabel(machine.data.vcpus, machine.data.memoryMiB),
          name: machine.data.sandboxName,
        }
      : null;
  const guidance =
    machine.status === "ready" && machine.data.state === "missing"
      ? (current?.summary ?? null)
      : null;
  return (
    <DropdownMenu
      onOpenChange={(open) => (open && !view.final ? refresh() : undefined)}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Vercel sandbox: ${view.spoken}`}
          className={cn(
            OPTION_BASE_CLASS_NAME,
            OPTION_INTERACTIVE_CLASS_NAME,
            "h-7",
            toneClass,
          )}
        >
          <Icon
            name={view.tone === "muted" ? "Clock" : "AlertTriangle"}
            className={cn("shrink-0", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
          />
          {isCompactViewport ? null : (
            <span className="min-w-0 truncate">{view.label}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        mobileTitle="Vercel sandbox"
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
      >
        <DropdownMenuLabel>Vercel sandbox</DropdownMenuLabel>
        <p
          className={cn(
            "max-w-72 whitespace-normal px-2 pb-1.5 text-xs leading-relaxed",
            view.tone === "muted" ? "text-foreground" : toneClass,
          )}
        >
          {view.detail}
        </p>
        {guidance === null || guidance === "" ? null : (
          <p className="max-w-72 whitespace-normal px-2 pb-1.5 text-xs leading-relaxed text-muted-foreground">
            {guidance}
          </p>
        )}
        {details === null ? null : (
          <p className="flex max-w-72 flex-col gap-0.5 px-2 pb-1.5 text-xs text-muted-foreground">
            <span>{details.size}</span>
            <span className="truncate font-mono">{details.name}</span>
          </p>
        )}
        {view.final ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                refresh();
              }}
              className="text-xs"
            >
              <Icon name="ArrowReloadHorizontal" className="size-3.5" />
              {machine.status === "error" ? "Retry" : "Refresh"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_machineProviderInputs({
    machineProviderId: PROVIDER_ID,
    component: VercelMachineInputsControl,
  });
  app.slots.settingsSection({
    id: "sandbox",
    component: VercelSettingsSection,
  });
  app.slots.experimental_threadHeaderAction({
    id: "expiry",
    title: "Vercel sandbox time limit",
    component: VercelExpiryIndicator,
  });
});
