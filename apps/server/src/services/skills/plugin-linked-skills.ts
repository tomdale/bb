import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  normalizeProviderResolvedNativeRoot,
} from "@bb/domain";
import {
  hostDaemonInjectedSkillSourceSchema,
  type DiscoveredSkill,
} from "@bb/host-daemon-contract";
import type { SkillSummary } from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  createProviderNativeRootsCache,
  providerHasNativeRootSurface,
  scanProviderNativeRoots,
} from "../providers/native-roots.js";
import { getPluginHostSkillRootContributions } from "../plugins/plugin-agent-contributions.js";
import type {
  LinkedInjectedSkillSource,
  PluginLinkedInjectedSkillSource,
} from "./injected-skills.js";
import { hostPathDirname } from "./shared-skills.js";

export interface ResolvedPluginLinkedSkills {
  runtimeSources: PluginLinkedInjectedSkillSource[];
  summaries: SkillSummary[];
}

const EMPTY_RESOLVED_PLUGIN_LINKED_SKILLS: ResolvedPluginLinkedSkills = {
  runtimeSources: [],
  summaries: [],
};

export function hasPluginLinkedSkillRoots(): boolean {
  return getPluginHostSkillRootContributions().length > 0;
}

function groupRootsByPlugin(): Map<string, string[]> {
  const byPlugin = new Map<string, string[]>();
  for (const { pluginId, rootPath } of getPluginHostSkillRootContributions()) {
    const roots = byPlugin.get(pluginId) ?? [];
    roots.push(rootPath);
    byPlugin.set(pluginId, roots);
  }
  return byPlugin;
}

async function scanPluginRoots(
  deps: LoggedWorkSessionDeps,
  args: { hostId: string; pluginId: string; rootPaths: readonly string[] },
): Promise<DiscoveredSkill[]> {
  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_skills",
        providerId: `bb-plugin:${args.pluginId}`,
        cwd: null,
        nativeRoots: {
          skills: EMPTY_PROVIDER_NATIVE_ROOTS,
          commands: EMPTY_PROVIDER_NATIVE_ROOTS,
          resolved: {
            skills: args.rootPaths.map((rootPath) =>
              normalizeProviderResolvedNativeRoot(
                { path: rootPath, origin: "user" },
                "skills",
              ),
            ),
            commands: [],
          },
        },
      },
    });
    return result.skills;
  } catch (error) {
    deps.logger.warn(
      { err: error, hostId: args.hostId, pluginId: args.pluginId },
      `Plugin "${args.pluginId}" skill roots could not be scanned; listing none`,
    );
    return [];
  }
}

function toLinkedSource(
  skill: DiscoveredSkill,
): LinkedInjectedSkillSource | null {
  const parsed = hostDaemonInjectedSkillSourceSchema.safeParse({
    kind: "linked-root",
    sourceType: "plugin",
    name: skill.name,
    description: skill.description,
    skillsRootPath: hostPathDirname(hostPathDirname(skill.filePath)),
    skillFilePath: skill.filePath,
  });
  return parsed.success && parsed.data.kind === "linked-root"
    ? parsed.data
    : null;
}

export async function resolvePluginLinkedSkills(
  deps: LoggedWorkSessionDeps,
  args: { hostId: string; nativeSkillFilePaths: ReadonlySet<string> },
): Promise<ResolvedPluginLinkedSkills> {
  const byPlugin = groupRootsByPlugin();
  if (byPlugin.size === 0) return EMPTY_RESOLVED_PLUGIN_LINKED_SKILLS;
  const scanned = await Promise.all(
    [...byPlugin].map(async ([pluginId, rootPaths]) => ({
      pluginId,
      skills: await scanPluginRoots(deps, {
        hostId: args.hostId,
        pluginId,
        rootPaths,
      }),
    })),
  );
  const resolved: ResolvedPluginLinkedSkills = {
    runtimeSources: [],
    summaries: [],
  };
  const names = new Set<string>();
  for (const { pluginId, skills } of scanned) {
    for (const skill of skills) {
      if (args.nativeSkillFilePaths.has(skill.filePath)) {
        deps.logger.debug(
          { filePath: skill.filePath, name: skill.name, pluginId },
          "Plugin skill already discovered by the provider's native roots",
        );
        continue;
      }
      const runtimeSource = toLinkedSource(skill);
      if (runtimeSource === null || names.has(skill.name)) {
        deps.logger.warn(
          { filePath: skill.filePath, name: skill.name, pluginId },
          runtimeSource === null
            ? "Skipping plugin skill with an invalid name or missing description"
            : "Skipping plugin skill whose name an earlier root claims",
        );
        continue;
      }
      names.add(skill.name);
      resolved.runtimeSources.push({ pluginId, runtimeSource });
      resolved.summaries.push({
        id: skill.id,
        name: skill.name,
        description: runtimeSource.description,
        provider: null,
        scope: "plugin",
        pluginId,
        filePath: skill.filePath,
        manageable: false,
        registrySkillId: null,
      });
    }
  }
  return resolved;
}

export async function resolveThreadPluginLinkedSkills(
  deps: LoggedWorkSessionDeps,
  args: { hostId: string; providerId: string; cwd: string },
): Promise<PluginLinkedInjectedSkillSource[]> {
  if (!hasPluginLinkedSkillRoots()) return [];
  const registration = deps.providerRegistry.get(args.providerId);
  let nativeSkillFilePaths = new Set<string>();
  if (registration !== null && providerHasNativeRootSurface(registration)) {
    try {
      const native = await scanProviderNativeRoots(
        { ...deps, providerNativeRoots: createProviderNativeRootsCache() },
        {
          type: "host.list_skills",
          registration,
          hostId: args.hostId,
          cwd: args.cwd,
        },
      );
      nativeSkillFilePaths = new Set(
        native.skills.map((skill) => skill.filePath),
      );
    } catch (error) {
      deps.logger.warn(
        { err: error, hostId: args.hostId, providerId: args.providerId },
        "Provider native skills could not be scanned; plugin skills are not deduplicated against them",
      );
    }
  }
  return (
    await resolvePluginLinkedSkills(deps, {
      hostId: args.hostId,
      nativeSkillFilePaths,
    })
  ).runtimeSources;
}
