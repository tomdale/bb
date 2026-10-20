import { and, desc, eq, sql } from "drizzle-orm";
import {
  createQueuedThreadMessageInTransaction,
  events as storedEvents,
  getThread,
  hasThreadTurnRequestAfterStart,
  wasThreadTurnManuallyStopped,
} from "@bb/db";
import { renderTemplate } from "@bb/templates";
import { z } from "zod";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { runQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  ENVIRONMENT_DIRECTORY_UPDATE_OPERATION,
  threadWritableFailure,
} from "./thread-environment-directory.js";

const environmentDirectoryUpdateDataSchema = z.object({
  status: z.literal("completed"),
  metadata: z.object({
    continue: z.boolean().default(true),
    nextEnvironmentId: z.string(),
    nextPath: z.string(),
  }),
});

export interface EnvironmentDirectoryContinuation {
  environmentId: string;
  path: string;
  turnId: string;
}

export function findEnvironmentDirectoryContinuation(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; turnId: string },
): EnvironmentDirectoryContinuation | null {
  const row = deps.db
    .select({ data: storedEvents.data })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.scopeKind, "turn"),
        eq(storedEvents.type, "system/operation"),
        sql`json_extract(${storedEvents.data}, '$.operation') = ${ENVIRONMENT_DIRECTORY_UPDATE_OPERATION}`,
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();
  if (!row) {
    return null;
  }
  const parsed = environmentDirectoryUpdateDataSchema.safeParse(
    JSON.parse(row.data),
  );
  if (!parsed.success || !parsed.data.metadata.continue) {
    return null;
  }
  return {
    environmentId: parsed.data.metadata.nextEnvironmentId,
    path: parsed.data.metadata.nextPath,
    turnId: args.turnId,
  };
}

export async function continueAfterEnvironmentDirectoryUpdate(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: EnvironmentDirectoryContinuation & { threadId: string },
): Promise<boolean> {
  const thread = getThread(deps.db, args.threadId);
  if (
    !thread ||
    thread.environmentId !== args.environmentId ||
    threadWritableFailure(thread) !== null ||
    wasThreadTurnManuallyStopped(deps.db, {
      threadId: args.threadId,
      turnId: args.turnId,
    })
  ) {
    return false;
  }
  if (thread.status === "starting" || thread.status === "active") {
    return true;
  }
  if (thread.status !== "idle") {
    return false;
  }
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: args.threadId },
  );
  const outcome = deps.db.transaction(
    (tx) => {
      const currentThread = getThread(tx, args.threadId);
      if (
        !currentThread ||
        currentThread.environmentId !== args.environmentId ||
        threadWritableFailure(currentThread) !== null ||
        wasThreadTurnManuallyStopped(tx, {
          threadId: args.threadId,
          turnId: args.turnId,
        })
      ) {
        return "unavailable";
      }
      if (
        currentThread.status === "starting" ||
        currentThread.status === "active" ||
        hasThreadTurnRequestAfterStart(tx, {
          threadId: args.threadId,
          turnId: args.turnId,
        })
      ) {
        return "continued";
      }
      if (currentThread.status !== "idle") {
        return "unavailable";
      }
      createQueuedThreadMessageInTransaction(tx, {
        threadId: args.threadId,
        content: [
          {
            type: "text",
            text: renderTemplate("systemMessageEnvironmentDirectoryUpdated", {
              path: args.path,
            }),
            mentions: [],
          },
        ],
        senderThreadId: null,
        requestedBy: null,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
        waitingOn:
          deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(
            args.threadId,
          )
            ? { kind: "interaction" }
            : null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind: "environment-directory-updated",
          subject: { kind: "directory", path: args.path },
        },
      });
      return "queued";
    },
    { behavior: "immediate" },
  );
  if (outcome === "unavailable") {
    return false;
  }
  if (outcome === "continued") {
    return true;
  }
  deps.hub.notifyThread(args.threadId, ["queue-changed"]);
  await runQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: args.threadId,
  });
  return true;
}
