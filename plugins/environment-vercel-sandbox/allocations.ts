import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  resolvedInputsSchema,
  scopeSchema,
  SafeError,
} from "./configuration.js";
import type { Credentials } from "./configuration.js";
import type { Sandbox } from "@vercel/sandbox";
import { PROVIDER_ID } from "./provider-id.js";

export const resourceSchema = scopeSchema
  .extend({
    version: z.literal(1),
    owner: z.string().uuid(),
    generation: z.string().uuid(),
    key: z.string().min(1).max(200),
    sandboxName: z.string().regex(/^bb-[a-f0-9]{48}$/),
    sessionId: z.string().min(1).nullable(),
    expiresAt: z.number().finite().nullable(),
    inputs: resolvedInputsSchema,
  })
  .strict();
export type Resource = z.infer<typeof resourceSchema>;
const intentSchema = z
  .object({
    phase: z.enum([
      "prepared",
      "submitted",
      "allocated",
      "stopping",
      "stop-accepted",
      "deleting",
      "removed",
    ]),
    resource: resourceSchema,
  })
  .strict();
export type Intent = z.infer<typeof intentSchema>;
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
export const allocationTags = (resource: Resource) => ({
  bbOwner: resource.owner,
  bbKey: digest(resource.key),
  bbProvider: PROVIDER_ID,
  bbGeneration: resource.generation,
});
export const allocationName = (owner: string, key: string) =>
  `bb-${digest(JSON.stringify([owner, key])).slice(0, 48)}`;

const operations = new Map<string, Promise<unknown>>();

export async function allocationStore(bb: Pick<BbPluginApi, "storage">) {
  const stored = await bb.storage.kv.get<unknown>("owner");
  const owner =
    stored === undefined ? randomUUID() : z.string().uuid().parse(stored);
  if (stored === undefined) await bb.storage.kv.set("owner", owner);
  const storageKey = (key: string) => `allocations/${digest(key)}`;
  return {
    owner,
    async run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const lockKey = JSON.stringify([owner, key]);
      const previous = operations.get(lockKey) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(task);
      operations.set(lockKey, operation);
      try {
        return await operation;
      } finally {
        if (operations.get(lockKey) === operation) operations.delete(lockKey);
      }
    },
    async get(key: string): Promise<Intent | null> {
      const value = await bb.storage.kv.get<unknown>(storageKey(key));
      return value === undefined ? null : intentSchema.parse(value);
    },
    async set(intent: Intent) {
      await bb.storage.kv.set(storageKey(intent.resource.key), intent);
    },
    parse(value: unknown): Resource {
      const parsed = resourceSchema.safeParse(value);
      if (!parsed.success)
        throw new SafeError(
          "Vercel machine resource is invalid; cleanup requires operator investigation.",
        );
      const resource = parsed.data;
      if (
        resource.owner !== owner ||
        resource.sandboxName !== allocationName(owner, resource.key)
      )
        throw new SafeError(
          "Vercel machine belongs to a different BB server allocation namespace.",
        );
      return resource;
    },
  };
}
export function assertScope(resource: Resource, settings: Credentials) {
  if (
    resource.teamId !== settings.teamId ||
    resource.projectId !== settings.projectId
  )
    throw new SafeError(
      "Restore this machine's original Vercel team and project settings before inspection or cleanup.",
    );
}
export function assertOwnership(resource: Resource, sandbox: Sandbox) {
  const tags = allocationTags(resource);
  if (
    sandbox.name !== resource.sandboxName ||
    sandbox.persistent ||
    Object.entries(tags).some(([key, value]) => sandbox.tags?.[key] !== value)
  )
    throw new SafeError(
      "Vercel allocation ownership does not match this BB machine; refusing access or deletion.",
    );
  if (
    resource.sessionId !== null &&
    sandbox.currentSession().sessionId !== resource.sessionId
  )
    throw new SafeError(
      "Vercel allocation session changed; refusing to replace or delete unrelated compute.",
    );
}
export function observedResource(
  resource: Resource,
  sandbox: Sandbox,
): Resource {
  return {
    ...resource,
    sessionId: sandbox.currentSession().sessionId,
    expiresAt: sandbox.expiresAt?.getTime() ?? resource.expiresAt,
  };
}
