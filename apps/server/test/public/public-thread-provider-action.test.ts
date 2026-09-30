import { listEvents } from "@bb/db";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const action = "generic.action";

function actionRequest(threadId: string, requestId: string, actionId = action) {
  return {
    path: `/api/v1/threads/${threadId}/provider-action`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: actionId, requestId }),
    },
  };
}

function actionEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (row) => row.type === "system/provider-action",
  );
}

describe("provider-owned thread actions", () => {
  it("serializes concurrent retries and returns the completed event boundary on replay", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      let resolveAction:
        | ((
            value: import("../helpers/host-rpc.js").HostRpcHandlerResult,
          ) => void)
        | undefined;
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "thread.provider.actions") {
            expect(actionEvents(harness, thread.id)).toHaveLength(0);
            return { ok: true, result: { actions: [action] } };
          }
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          expect(command).toMatchObject({
            threadId: thread.id,
            action,
            requestId: firstId,
          });
          expect(
            actionEvents(harness, thread.id).map(
              (row) => JSON.parse(row.data).status,
            ),
          ).toEqual(["pending"]);
          return new Promise((resolve) => {
            resolveAction = resolve;
          });
        },
      });
      const request = actionRequest(thread.id, firstId);
      const first = harness.app.request(request.path, request.init);
      await vi.waitFor(() =>
        expect(responder.requests.length).toBeGreaterThan(0),
      );
      expect(responder.requests.map((entry) => entry.command.type)).toContain(
        "thread.provider.actions",
      );
      await vi.waitFor(() =>
        expect(actionEvents(harness, thread.id).length).toBe(1),
      );
      await vi.waitFor(() =>
        expect(
          responder.requests.some(
            (entry) => entry.command.type === "thread.provider.action",
          ),
        ).toBe(true),
      );
      const concurrent = harness.app.request(request.path, request.init);
      const otherId = actionRequest(thread.id, secondId);
      const conflictPromise = harness.app.request(otherId.path, otherId.init);
      resolveAction?.({
        ok: true,
        result: { accepted: true, count: 7 } as never,
      });
      const response = await first;
      const concurrentResponse = await concurrent;
      const conflict = await conflictPromise;
      expect(conflict.status).toBe(409);
      expect(response.status).toBe(200);
      const result = (await readJson(response)) as {
        result: unknown;
        boundarySequence: number;
      };
      expect(result.result).toEqual({ accepted: true, count: 7 });
      expect(await readJson(concurrentResponse)).toMatchObject(result);
      const rows = actionEvents(harness, thread.id);
      expect(rows.map((row) => JSON.parse(row.data).status)).toEqual([
        "pending",
        "completed",
      ]);
      expect(result.boundarySequence).toBe(rows[1]!.sequence);
      const replay = await harness.app.request(request.path, request.init);
      expect(await readJson(replay)).toEqual(result);
      expect(
        responder.requests.filter(
          (entry) => entry.command.type === "thread.provider.action",
        ),
      ).toHaveLength(1);
    });
  });

  it("rejects an unsupported action before creating pending state", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "thread.provider.actions")
            return { ok: true, result: { actions: [action] } };
          throw new Error(`Action must not dispatch: ${command.type}`);
        },
      });
      const request = actionRequest(thread.id, firstId, "unsupported.action");
      const response = await harness.app.request(request.path, request.init);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
        message: "The provider does not allow this action",
      });
      expect(actionEvents(harness, thread.id)).toHaveLength(0);
      expect(responder.requests.map((entry) => entry.command.type)).toEqual([
        "thread.provider.actions",
      ]);
    });
  });

  it("leaves uncertain actions pending and same-UUID retry recovers after reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      let calls = 0;
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "thread.provider.actions")
            return { ok: true, result: { actions: [action] } };
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          calls += 1;
          if (calls === 1) throw new Error("transport outcome unknown");
          return { ok: true, result: { done: true } as never };
        },
      });
      const request = actionRequest(thread.id, firstId);
      const failed = await harness.app.request(request.path, request.init);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(
        actionEvents(harness, thread.id).map(
          (row) => JSON.parse(row.data).status,
        ),
      ).toEqual(["pending"]);
      const retried = await harness.app.request(request.path, request.init);
      expect(retried.status).toBe(200);
      expect(await readJson(retried)).toMatchObject({ result: { done: true } });
      expect(
        actionEvents(harness, thread.id).map(
          (row) => JSON.parse(row.data).status,
        ),
      ).toEqual(["pending", "completed"]);
      expect(calls).toBe(2);
    });
  });

  it("blocks turn admission while an action is pending", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      let resolveAction:
        | ((
            value: import("../helpers/host-rpc.js").HostRpcHandlerResult,
          ) => void)
        | undefined;
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "thread.provider.actions")
            return { ok: true, result: { actions: [action] } };
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          return new Promise((resolve) => {
            resolveAction = resolve;
          });
        },
      });
      const request = actionRequest(thread.id, firstId);
      const pending = harness.app.request(request.path, request.init);
      await vi.waitFor(() =>
        expect(actionEvents(harness, thread.id)).toHaveLength(1),
      );
      const send = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "hello" }],
            mode: "queue-if-active",
          }),
        },
      );
      expect(send.status).toBe(500);
      resolveAction?.({ ok: true, result: null as never });
      await pending;
    });
  });

  it("conflicts when a completed UUID is reused for another action", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) =>
          command.type === "thread.provider.actions"
            ? { ok: true, result: { actions: [action, "another.action"] } }
            : command.type === "thread.provider.action"
              ? { ok: true, result: null }
              : (() => {
                  throw new Error(`Unexpected ${command.type}`);
                })(),
      });
      const request = actionRequest(thread.id, firstId);
      expect(
        (await harness.app.request(request.path, request.init)).status,
      ).toBe(200);
      const conflict = actionRequest(thread.id, firstId, "another.action");
      expect(
        (await harness.app.request(conflict.path, conflict.init)).status,
      ).toBe(409);
      expect(
        responder.requests.filter(
          (entry) => entry.command.type === "thread.provider.action",
        ),
      ).toHaveLength(1);
    });
  });

  it("keeps pending when completion persistence fails and retries provider idempotently", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host, session } = seedThreadFixture(harness, {
        thread: { providerId: "fake-provider" },
      });
      let calls = 0;
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "thread.provider.actions")
            return { ok: true, result: { actions: [action] } };
          if (command.type !== "thread.provider.action")
            throw new Error(`Unexpected ${command.type}`);
          calls += 1;
          return { ok: true, result: { stable: "result" } as never };
        },
      });
      harness.db.run(
        sql`CREATE TRIGGER fail_provider_action_completion BEFORE INSERT ON events WHEN NEW.type = 'system/provider-action' AND json_extract(NEW.data, '$.status') = 'completed' BEGIN SELECT RAISE(ABORT, 'completion failed'); END`,
      );
      const request = actionRequest(thread.id, firstId);
      const failed = await harness.app.request(request.path, request.init);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(
        actionEvents(harness, thread.id).map(
          (row) => JSON.parse(row.data).status,
        ),
      ).toEqual(["pending"]);
      harness.db.run(sql`DROP TRIGGER fail_provider_action_completion`);
      const retried = await harness.app.request(request.path, request.init);
      const result = (await readJson(retried)) as { boundarySequence: number };
      expect(result.boundarySequence).toBe(
        actionEvents(harness, thread.id)[1]!.sequence,
      );
      expect(calls).toBe(2);
      expect(
        responder.requests.filter(
          (entry) => entry.command.type === "thread.provider.action",
        ),
      ).toHaveLength(2);
    });
  });
});
