import { listEvents } from "@bb/db";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

function resetRequest(threadId: string, requestId: string) {
  return {
    path: `/api/v1/threads/${threadId}/provider-action`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pi-todo.reset", requestId }),
    },
  };
}

describe("Pi Todo reset provider action", () => {
  it("persists pending before Pi, returns one completed boundary, and reuses it on retry", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "pi" },
      });
      const finish: Array<
        (value: { ok: true; result: { nextId: number } }) => void
      > = [];
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          expect(command).toMatchObject({
            threadId: thread.id,
            action: "pi-todo.reset",
            requestId: firstId,
          });
          const pending = listEvents(harness.db, {
            threadId: thread.id,
          }).filter((row) => row.type === "system/plugin-todo-reset");
          expect(pending).toHaveLength(1);
          expect(JSON.parse(pending[0]!.data)).toMatchObject({
            status: "pending",
            requestId: firstId,
          });
          return new Promise((resolve) => {
            finish.push(resolve);
          });
        },
      });
      const request = resetRequest(thread.id, firstId);
      const first = harness.app.request(request.path, request.init);
      await vi.waitFor(() =>
        expect(
          responder.requests.filter(
            (entry) => entry.command.type === "thread.provider.action",
          ),
        ).toHaveLength(1),
      );
      const concurrent = harness.app.request(request.path, request.init);
      await vi.waitFor(() =>
        expect(
          responder.requests.filter(
            (entry) => entry.command.type === "thread.provider.action",
          ),
        ).toHaveLength(2),
      );
      const pendingWhileConcurrent = listEvents(harness.db, {
        threadId: thread.id,
      }).filter((row) => row.type === "system/plugin-todo-reset");
      expect(pendingWhileConcurrent).toHaveLength(1);
      const conflict = resetRequest(thread.id, secondId);
      const conflictResponse = await harness.app.request(
        conflict.path,
        conflict.init,
      );
      expect(conflictResponse.status).toBe(409);
      for (const resolve of finish)
        resolve({ ok: true, result: { nextId: 7 } });
      const response = await first;
      const concurrentResponse = await concurrent;
      expect(response.status).toBe(200);
      expect(await readJson(concurrentResponse)).toEqual(
        await readJson(response.clone()),
      );
      const result = (await readJson(response)) as {
        nextId: number;
        boundarySequence: number;
      };
      expect(result.nextId).toBe(7);
      const events = listEvents(harness.db, { threadId: thread.id }).filter(
        (row) => row.type === "system/plugin-todo-reset",
      );
      expect(events.map((event) => JSON.parse(event.data).status)).toEqual([
        "pending",
        "completed",
      ]);
      expect(result.boundarySequence).toBe(events[1]!.sequence);
      const repeated = await harness.app.request(request.path, request.init);
      expect(await readJson(repeated)).toEqual(result);
      expect(
        responder.requests.filter(
          (entry) => entry.command.type === "thread.provider.action",
        ),
      ).toHaveLength(2);
    });
  });

  it("retries the same Pi checkpoint after the BB completion append fails", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "pi" },
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          expect(command.requestId).toBe(firstId);
          return { ok: true, result: { nextId: 7 } };
        },
      });
      harness.db.run(
        sql`CREATE TRIGGER fail_todo_completion BEFORE INSERT ON events WHEN NEW.type = 'system/plugin-todo-reset' AND json_extract(NEW.data, '$.status') = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failed'); END`,
      );
      const request = resetRequest(thread.id, firstId);
      const failed = await harness.app.request(request.path, request.init);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(
        listEvents(harness.db, { threadId: thread.id })
          .filter((row) => row.type === "system/plugin-todo-reset")
          .map((row) => JSON.parse(row.data).status),
      ).toEqual(["pending"]);
      harness.db.run(sql`DROP TRIGGER fail_todo_completion`);
      const retried = await harness.app.request(request.path, request.init);
      expect(retried.status).toBe(200);
      const result = (await readJson(retried)) as {
        nextId: number;
        boundarySequence: number;
      };
      const events = listEvents(harness.db, { threadId: thread.id }).filter(
        (row) => row.type === "system/plugin-todo-reset",
      );
      expect(events.map((row) => JSON.parse(row.data).status)).toEqual([
        "pending",
        "completed",
      ]);
      expect(result).toEqual({
        nextId: 7,
        boundarySequence: events[1]!.sequence,
      });
      expect(
        responder.requests.filter(
          (entry) => entry.command.type === "thread.provider.action",
        ),
      ).toHaveLength(2);
    });
  });
});
