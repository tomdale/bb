import { randomUUID } from "node:crypto";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import {
  allocationName,
  allocationStore,
  allocationTags,
  assertOwnership,
  assertScope,
  observedResource,
  type Resource,
  type Intent,
} from "./allocations.js";
import { createVercelClient, sandboxExecutor } from "./client.js";
import {
  allowedVcpus,
  launchInputsSchema,
  resolvedInputsSchema,
  resolveSettings,
  SafeError,
  safeMessage,
  SETTING_DESCRIPTORS,
} from "./configuration.js";
import { IMAGE, PROVIDER_ID } from "./provider-id.js";
import { vercelRpcContract } from "./rpc.js";

export function createVercelSandboxPlugin(transport: typeof fetch) {
  return async (bb: BbPluginApi) => {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);
    const allocations = await allocationStore(bb);
    const lifetime = new AbortController();
    bb.onDispose(() => lifetime.abort());
    const currentSettings = async () => resolveSettings(await settings.get());
    const operationSignal = (signal?: AbortSignal, timeoutMs = 30_000) =>
      AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(timeoutMs),
        ...(signal ? [signal] : []),
      ]);
    const clientFor = async (resource?: Resource) => {
      const current = await currentSettings();
      if (resource) assertScope(resource, current);
      return createVercelClient(current, transport);
    };
    const launchOptions = async () => {
      const raw = await settings.get();
      const defaults = resolvedInputsSchema.safeParse({
        vcpus: raw.defaultVcpus,
        timeoutMinutes: raw.defaultTimeoutMinutes,
      });
      if (!defaults.success)
        throw new SafeError(
          "Default vCPUs must be 1 or an even count up to 32 and lifetime must be 5–1440 whole minutes.",
        );
      return {
        image: IMAGE,
        defaultInputs: defaults.data,
        limits: {
          minVcpus: 1,
          maxVcpus: 32,
          allowedVcpus,
          minTimeoutMinutes: 5,
          maxTimeoutMinutes: 1440,
        },
        memoryMiBPerVcpu: 2048,
      };
    };
    const inspectAccount = async (signal?: AbortSignal) => {
      let teamId: string | null = null;
      let projectId: string | null = null;
      try {
        const current = await currentSettings();
        teamId = current.teamId;
        projectId = current.projectId;
        await createVercelClient(current, transport).inspectAccount(
          operationSignal(signal),
        );
        return {
          available: true,
          message:
            "Authenticated sandbox listing succeeded for the configured team and project. Create permission and plan capacity are checked at launch.",
          teamId,
          projectId,
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          available: false,
          message: safeMessage(error),
          teamId,
          projectId,
        };
      }
    };
    const inspectMachine = async (
      { hostId }: { hostId: string },
      signal?: AbortSignal,
    ) => {
      const host = await bb.sdk.hosts.get({ hostId });
      if (host.machineProviderId !== PROVIDER_ID)
        throw new SafeError(
          "This machine is not owned by the Vercel Sandbox provider.",
        );
      const resource = allocations.parse(
        await bb.experimental_machines.getResource(hostId),
      );
      const intent = await allocations.get(resource.key);
      if (intent && intent.resource.generation !== resource.generation)
        throw new SafeError(
          "Vercel allocation session changed; refusing inspection of replacement compute.",
        );
      const client = await clientFor(resource);
      const sandbox = await client.get(
        resource.sandboxName,
        operationSignal(signal),
      );
      if (sandbox) assertOwnership(resource, sandbox);
      const sessionResource = sandbox
        ? observedResource(resource, sandbox)
        : resource;
      const session =
        sessionResource.sessionId === null
          ? null
          : await client.getSession(sessionResource, operationSignal(signal));
      const stopConfirmed =
        intent !== null && ["deleting", "removed"].includes(intent.phase);
      const values = {
        computeEnded: session?.status === "stopped",
        state: session?.status ?? ("missing" as const),
        sandboxName: resource.sandboxName,
        sessionId: sandbox
          ? sandbox.currentSession().sessionId
          : resource.sessionId,
        expiresAt: sandbox?.expiresAt?.getTime() ?? resource.expiresAt,
        vcpus: sandbox?.vcpus ?? resource.inputs.vcpus,
        memoryMiB: sandbox?.memory ?? resource.inputs.vcpus * 2048,
        image: sandbox?.image ?? IMAGE,
        teamId: resource.teamId,
        projectId: resource.projectId,
      };
      return {
        summary: `Vercel sandbox ${values.sandboxName}: ${values.state}. ${values.expiresAt === null ? "No vendor expiry is available." : `Recorded vendor expiry ${new Date(values.expiresAt).toISOString()}.`} ${session ? "Files are disposable; save important work to Git." : stopConfirmed ? "BB durably confirmed this session stopped before metadata deletion." : "Missing metadata does not confirm compute termination. Retain this machine and its original account settings, inspect the recorded session in Vercel or contact Vercel support, then retry cleanup."}`,
        values,
      };
    };
    bb.rpc.register(vercelRpcContract, {
      "launch.options": async () => {
        try {
          return await launchOptions();
        } catch (error) {
          throw new Error(safeMessage(error));
        }
      },
      "account.inspect": () => inspectAccount(),
      "machine.inspect": async (input) => {
        try {
          return await inspectMachine(input);
        } catch (error) {
          throw new Error(safeMessage(error));
        }
      },
    });
    const jsonOption = {
      json: { type: "boolean", description: "Emit the typed result as JSON" },
    } as const;
    const guarded = async (
      run: () => Promise<{ exitCode: number; stdout: string }>,
    ) => {
      try {
        return await run();
      } catch (error) {
        throw new PluginCliError(safeMessage(error));
      }
    };
    bb.cli.register(
      defineCli({
        name: "vercel-sandbox",
        summary: "Inspect Vercel Sandbox configuration and machines",
        commands: {
          "account inspect": cliCommand({
            summary:
              "Check authenticated sandbox listing without allocating compute",
            options: jsonOption,
            run(input, context) {
              return guarded(async () => {
                const result = await inspectAccount(context.signal);
                return {
                  exitCode: result.available ? 0 : 1,
                  stdout: input.options.json
                    ? JSON.stringify(result)
                    : result.message,
                };
              });
            },
          }),
          "launch options": cliCommand({
            summary: "Show launch defaults and provider resource limits",
            options: jsonOption,
            run(input) {
              return guarded(async () => {
                const result = await launchOptions();
                return {
                  exitCode: 0,
                  stdout: JSON.stringify(
                    result,
                    null,
                    input.options.json ? undefined : 2,
                  ),
                };
              });
            },
          }),
          "machine inspect": cliCommand({
            summary:
              "Inspect an owned allocation without starting stopped compute",
            positionals: [
              {
                name: "host-id",
                description: "BB Vercel machine ID",
                required: true,
              },
            ],
            options: jsonOption,
            run(input, context) {
              return guarded(async () => {
                const result = await inspectMachine(
                  { hostId: input.positionals["host-id"] },
                  context.signal,
                );
                return {
                  exitCode: 0,
                  stdout: input.options.json
                    ? JSON.stringify(result)
                    : result.summary,
                };
              });
            },
          }),
        },
      }),
    );

    async function saveIntent(intent: Intent, signal: AbortSignal) {
      lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      await allocations.set(intent);
    }
    async function cleanup(resource: Resource, signal: AbortSignal) {
      lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      let intent = await allocations.get(resource.key);
      if (intent && intent.resource.generation !== resource.generation)
        throw new SafeError(
          "Vercel allocation session changed; refusing stale cleanup of replacement compute.",
        );
      if (intent?.phase === "removed") return;
      resource = intent?.resource ?? resource;
      const client = await clientFor(resource);
      let sandbox = await client.get(
        resource.sandboxName,
        operationSignal(signal),
      );
      if (sandbox) {
        assertOwnership(resource, sandbox);
        resource = observedResource(resource, sandbox);
      }
      if (intent?.phase !== "deleting") {
        let state =
          resource.sessionId === null
            ? undefined
            : (await client.getSession(resource, operationSignal(signal)))
                ?.status;
        if (state !== "stopped") {
          if (
            intent?.phase !== "stop-accepted" ||
            state === "pending" ||
            state === "running"
          )
            await saveIntent({ phase: "stopping", resource }, signal);
          if (state === "pending" || state === "running") {
            try {
              if (sandbox)
                await sandbox
                  .currentSession()
                  .stop({ signal: operationSignal(signal) });
              else await client.stopSession(resource, operationSignal(signal));
              await saveIntent({ phase: "stop-accepted", resource }, signal);
            } catch {
              lifetime.signal.throwIfAborted();
              signal.throwIfAborted();
            }
          }
          sandbox = await client.get(
            resource.sandboxName,
            operationSignal(signal),
          );
          if (sandbox) {
            assertOwnership(resource, sandbox);
          }
          state =
            resource.sessionId === null
              ? undefined
              : (await client.getSession(resource, operationSignal(signal)))
                  ?.status;
          if (state !== "stopped")
            throw new SafeError(
              "Vercel compute termination is unresolved and unconfirmed. Retain the machine record and original account settings; inspect the recorded session in Vercel or contact Vercel support, then retry cleanup. A missing name or session does not prove compute has stopped.",
            );
        }
        intent = { phase: "deleting", resource };
        await saveIntent(intent, signal);
      }
      if (sandbox) {
        try {
          await sandbox.delete({
            deleteOrphanSnapshots: true,
            signal: operationSignal(signal),
          });
        } catch {
          lifetime.signal.throwIfAborted();
          signal.throwIfAborted();
        }
        const remaining = await client.get(
          resource.sandboxName,
          operationSignal(signal),
        );
        if (remaining) {
          assertOwnership(resource, remaining);
          throw new SafeError(
            "Vercel compute is stopped but named metadata removal is unconfirmed. Retry cleanup.",
          );
        }
      }
      await saveIntent({ phase: "removed", resource }, signal);
    }
    bb.experimental_environments.register({
      id: PROVIDER_ID,
      displayName: "Vercel Sandbox",
      description:
        "Disposable Vercel compute with a project checkout; files expire with compute.",
      icon: "./vercel-logo.svg",
      machineProviderId: PROVIDER_ID,
      environmentProviderId: "project-checkout",
    });
    bb.experimental_machines.register({
      id: PROVIDER_ID,
      displayName: "Vercel Sandbox",
      description:
        "Disposable Vercel machine with an explicit lifetime; save important work to Git.",
      icon: "./vercel-logo.svg",
      ephemeral: true,
      inputs: launchInputsSchema,
      async availability() {
        try {
          await currentSettings();
          return { status: "available" };
        } catch (error) {
          return { status: "setup-required", message: safeMessage(error) };
        }
      },
      async validate({ inputs }) {
        try {
          launchInputsSchema.parse(inputs);
          await currentSettings();
          return { action: "accept" };
        } catch (error) {
          return {
            action: "refuse",
            message:
              error instanceof SafeError
                ? error.message
                : "Choose 1 vCPU or an even count up to 32 and 5–1440 whole minutes.",
          };
        }
      },
      async create(context) {
        return allocations.run(context.key, async () => {
          try {
            lifetime.signal.throwIfAborted();
            context.signal.throwIfAborted();
            const current = await currentSettings();
            const inputs = launchInputsSchema.parse(context.inputs);
            let intent = await allocations.get(context.key);
            if (intent?.phase === "removed") intent = null;
            if (
              intent &&
              ["stopping", "stop-accepted", "deleting"].includes(intent.phase)
            )
              throw new SafeError(
                "Vercel machine cleanup is pending. Retry cleanup before launching with this creation key.",
              );
            if (!intent) {
              intent = {
                phase: "prepared",
                resource: {
                  version: 1,
                  owner: allocations.owner,
                  generation: randomUUID(),
                  key: context.key,
                  sandboxName: allocationName(allocations.owner, context.key),
                  sessionId: null,
                  expiresAt: null,
                  teamId: current.teamId,
                  projectId: current.projectId,
                  inputs: { ...current.defaults, ...inputs },
                },
              };
              await saveIntent(intent, context.signal);
            }
            let resource = allocations.parse(intent.resource);
            assertScope(resource, current);
            const client = createVercelClient(current, transport);
            context.report.step("Checking Vercel allocation");
            let sandbox = await client.get(
              resource.sandboxName,
              operationSignal(context.signal),
            );
            if (!sandbox) {
              if (intent.phase !== "prepared")
                throw new SafeError(
                  "The Vercel allocation is missing or its submission is unresolved. Refusing to replace potentially lost files; remove this machine and inspect cleanup before launching again.",
                );
              context.signal.throwIfAborted();
              context.report.step("Allocating disposable Vercel compute");
              intent = { phase: "submitted", resource };
              await saveIntent(intent, context.signal);
              if (context.signal.aborted) {
                await saveIntent(
                  { phase: "removed", resource },
                  lifetime.signal,
                );
                context.signal.throwIfAborted();
              }
              try {
                sandbox = await client.create(
                  resource.sandboxName,
                  allocationTags(resource),
                  resource.inputs,
                  operationSignal(context.signal, 180_000),
                );
              } catch {
                context.signal.throwIfAborted();
                sandbox = await client.get(
                  resource.sandboxName,
                  operationSignal(context.signal),
                );
                if (!sandbox)
                  throw new SafeError(
                    "Vercel allocation submission is unresolved. Cleanup will keep checking the durable sandbox name; retain the original account settings.",
                  );
              }
            }
            assertOwnership(resource, sandbox);
            resource = observedResource(resource, sandbox);
            await saveIntent({ phase: "allocated", resource }, context.signal);
            await context.checkpoint(resource);
            context.signal.throwIfAborted();
            if (
              sandbox.status !== "running" ||
              sandbox.currentSession().status !== "running"
            )
              throw new SafeError(
                "Vercel compute is no longer running. Refusing to restore a disposable filesystem; remove the machine and launch again.",
              );
            context.report.step("Installing BB on Vercel compute");
            const { hostId } = await bb.experimental_machines.bootstrap({
              key: context.key,
              executor: sandboxExecutor(sandbox),
              report: context.report,
              signal: operationSignal(context.signal, 15 * 60_000),
            });
            context.signal.throwIfAborted();
            return {
              status: "created",
              name: `Vercel sandbox ${hostId.slice(-6)}`,
              resource,
            };
          } catch (error) {
            context.signal.throwIfAborted();
            return { status: "failed", message: safeMessage(error) };
          }
        });
      },
      async reconcileCleanup({ key, signal }) {
        return allocations.run(key, async () => {
          try {
            lifetime.signal.throwIfAborted();
            signal.throwIfAborted();
            const intent = await allocations.get(key);
            if (!intent || intent.phase === "removed")
              return { status: "removed" };
            if (intent.phase === "prepared") {
              await saveIntent({ ...intent, phase: "removed" }, signal);
              return { status: "removed" };
            }
            await cleanup(allocations.parse(intent.resource), signal);
            return { status: "removed" };
          } catch (error) {
            signal.throwIfAborted();
            return { status: "failed", message: safeMessage(error) };
          }
        });
      },
      async remove({ resource, signal }) {
        try {
          const parsed = allocations.parse(resource);
          await allocations.run(parsed.key, () => cleanup(parsed, signal));
          return { status: "removed" };
        } catch (error) {
          signal.throwIfAborted();
          return { status: "failed", message: safeMessage(error) };
        }
      },
    });
    try {
      await currentSettings();
    } catch (error) {
      bb.status.needsConfiguration(safeMessage(error));
    }
  };
}
export default createVercelSandboxPlugin(globalThis.fetch);
