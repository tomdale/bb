import { and, eq } from "drizzle-orm";
import { events, type DbQueryConnection } from "@bb/db";
import { systemPluginTodoResetEventDataSchema } from "@bb/domain";
import { parseStoredEventPayload } from "./thread-data.js";

export function getPiTodoResetState(
  db: DbQueryConnection,
  threadId: string,
): {
  pendingRequestId: string | null;
  completed: Map<string, { nextId: number; boundarySequence: number }>;
} {
  const completed = new Map<
    string,
    { nextId: number; boundarySequence: number }
  >();
  let pendingRequestId: string | null = null;
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
        eq(events.type, "system/plugin-todo-reset"),
      ),
    )
    .orderBy(events.sequence)
    .all();
  for (const row of rows) {
    const event = systemPluginTodoResetEventDataSchema.parse(
      parseStoredEventPayload(row),
    );
    if (event.status === "pending") {
      if (!completed.has(event.requestId)) pendingRequestId = event.requestId;
    } else if (event.nextId !== undefined) {
      completed.set(event.requestId, {
        nextId: event.nextId,
        boundarySequence: row.sequence,
      });
      if (pendingRequestId === event.requestId) pendingRequestId = null;
    }
  }
  return { pendingRequestId, completed };
}
