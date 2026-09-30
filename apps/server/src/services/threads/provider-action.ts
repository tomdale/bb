import { and, eq } from "drizzle-orm";
import { events, type DbQueryConnection } from "@bb/db";
import {
  systemProviderActionEventDataSchema,
  type JsonValue,
} from "@bb/domain";
import { parseStoredEventPayload } from "./thread-data.js";

export interface ProviderActionCompletion {
  action: string;
  requestId: string;
  result: JsonValue;
  boundarySequence: number;
}

export interface ProviderActionState {
  pending: { action: string; requestId: string } | null;
  completed: Map<string, ProviderActionCompletion>;
}

export function getProviderActionState(
  db: DbQueryConnection,
  threadId: string,
): ProviderActionState {
  const completed = new Map<string, ProviderActionCompletion>();
  let pending: ProviderActionState["pending"] = null;
  const rows = db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/provider-action"),
      ),
    )
    .orderBy(events.sequence)
    .all();
  for (const row of rows) {
    const event = systemProviderActionEventDataSchema.parse(
      parseStoredEventPayload(row),
    );
    if (event.status === "pending") {
      if (!completed.has(event.requestId)) {
        if (pending !== null && pending.requestId !== event.requestId) {
          throw new Error(
            "Stored provider-action events contain multiple pending requests",
          );
        }
        pending = { action: event.action, requestId: event.requestId };
      }
    } else if (event.status === "completed") {
      const completion = {
        action: event.action,
        requestId: event.requestId,
        result: event.result as JsonValue,
        boundarySequence: row.sequence,
      };
      completed.set(event.requestId, completion);
      if (pending?.requestId === event.requestId) pending = null;
    }
  }
  return { pending, completed };
}
