import type { JsonValue, MachineBootstrapRequest } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { resourceSchema } from "./allocations.js";
import { createVercelSandboxPlugin } from "./server.js";
import { vendorTransport } from "./vendor-test-transport.js";
import { launchInputsSchema } from "./configuration.js";

const report = { step() {}, log() {} };
const settings = {
  token: "secret-token",
  teamId: "team_test",
  projectId: "prj_test",
};
async function setup(
  options: {
    bootstrap?: (
      request: MachineBootstrapRequest,
    ) => Promise<{ hostId: string }>;
  } = {},
) {
  const vendor = vendorTransport();
  let stored: JsonValue | null = null;
  let bootstraps = 0;
  const host = createFakePluginHost({
    pluginId: "environment-vercel-sandbox",
    settings,
    machineResource: async () => stored,
    sdk: {
      hosts: {
        get: () => makeHostResponse({ machineProviderId: "vercel-sandbox" }),
      },
    },
    machineBootstrap: {
      async bootstrap(request) {
        bootstraps++;
        return options.bootstrap
          ? options.bootstrap(request)
          : { hostId: "host_vercel" };
      },
    },
  });
  await createVercelSandboxPlugin(vendor.transport)(host.bb);
  const machine =
    host.harness.registrations.machineProviders.get("vercel-sandbox")!;
  const signal = new AbortController().signal;
  const context = {
    key: "machine-key",
    attempt: 1,
    inputs: null,
    signal,
    report,
    async checkpoint(resource: JsonValue) {
      stored = resource;
    },
  };
  return {
    ...host,
    vendor,
    machine,
    context,
    get stored() {
      return stored;
    },
    set stored(value: JsonValue | null) {
      stored = value;
    },
    get bootstraps() {
      return bootstraps;
    },
  };
}

describe("Vercel machine allocation", () => {
  it.each([401, 403, 404, 422])(
    "recovers allocation accepted before a %s create response rather than discarding intent",
    async (status) => {
      const test = await setup();
      test.vendor.acceptOnClientError = true;
      test.vendor.failure = status;
      expect(await test.machine.create(test.context)).toMatchObject({
        status: "created",
      });
      expect(test.bootstraps).toBe(1);
      expect(
        test.vendor.requests.filter(
          (request) =>
            request.url.pathname === "/api/v3/sandboxes" &&
            request.method === "POST",
        ),
      ).toHaveLength(1);
      expect(await test.machine.reconcileCleanup(test.context)).toEqual({
        status: "removed",
      });
      expect(test.vendor.allocationCount).toBe(1);
    },
  );
  it("confirms stop via a fresh read and durably records confirmation before asynchronous metadata deletion", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const resource = resourceSchema.parse(test.stored);
    const intent = async () =>
      test.bb.storage.kv.get(
        (await test.bb.storage.kv.list("allocations/"))[0]!,
      );
    test.vendor.onStop = async () => {
      expect(await intent()).toMatchObject({
        phase: "stopping",
        resource: { sessionId: resource.sessionId },
      });
    };
    test.vendor.onDelete = async () => {
      expect(await intent()).toMatchObject({
        phase: "deleting",
        resource: { sessionId: resource.sessionId },
      });
      expect(test.vendor.sessions.get(resource.sessionId!)?.status).toBe(
        "stopped",
      );
      const stopIndex = test.vendor.requests.findIndex((request) =>
        request.url.pathname.endsWith("/stop"),
      );
      expect(
        test.vendor.requests
          .slice(stopIndex + 1, -1)
          .some(
            (request) =>
              request.method === "GET" &&
              request.url.pathname.endsWith(resource.sandboxName),
          ),
      ).toBe(true);
    };
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(test.vendor.sessions.get(resource.sessionId!)?.status).toBe(
      "stopped",
    );
    expect(await intent()).toMatchObject({
      phase: "removed",
      resource: { sessionId: resource.sessionId },
    });
  });

  it("retains accepted stop intent while termination is pending and retries deletion without another stop", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const resource = resourceSchema.parse(test.stored);
    test.vendor.stopStatus = "stopping";
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("unconfirmed"),
    });
    expect(test.vendor.deleteCount).toBe(0);
    expect(
      await test.bb.storage.kv.get(
        (await test.bb.storage.kv.list("allocations/"))[0]!,
      ),
    ).toMatchObject({ phase: "stop-accepted" });
    expect(await test.machine.create(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("cleanup is pending"),
    });
    const allocation = test.vendor.allocations.get(resource.sandboxName)!;
    allocation.session.status = "stopped";
    allocation.sandbox.status = "stopped";
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(
      test.vendor.requests.filter((request) =>
        request.url.pathname.endsWith("/stop"),
      ),
    ).toHaveLength(1);
    expect(test.vendor.deleteCount).toBe(1);
  });

  it.each(["network-after", 429, 503] as const)(
    "recovers lost stop receipt %s by observing terminal state without transport mutation retries",
    async (failure) => {
      const test = await setup();
      await test.machine.create(test.context);
      test.vendor.stopFailure = failure;
      expect(await test.machine.reconcileCleanup(test.context)).toEqual({
        status: "removed",
      });
      expect(
        test.vendor.requests.filter((request) =>
          request.url.pathname.endsWith("/stop"),
        ),
      ).toHaveLength(1);
    },
  );

  it("retains stop/delete retry intent and never treats missing hidden sessions as terminated", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const resource = resourceSchema.parse(test.stored);
    test.vendor.stopFailure = "network-before";
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
    });
    expect(test.vendor.deleteCount).toBe(0);
    test.vendor.allocations.delete(resource.sandboxName);
    test.vendor.hiddenSessions.add(resource.sessionId!);
    expect(test.vendor.sessions.get(resource.sessionId!)?.status).toBe(
      "running",
    );
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("unconfirmed"),
    });
    const diagnostic = await test.harness.behavior.callRpc("machine.inspect", {
      hostId: "host_vercel",
    });
    expect(diagnostic).toMatchObject({
      values: {
        state: "missing",
        sessionId: resource.sessionId,
        expiresAt: resource.expiresAt,
      },
      summary: expect.stringContaining("does not confirm"),
    });
    expect(
      await test.bb.storage.kv.get(
        (await test.bb.storage.kv.list("allocations/"))[0]!,
      ),
    ).toMatchObject({
      phase: "stopping",
      resource: { sessionId: resource.sessionId },
    });
  });

  it("retains durable stop proof across a failed delete and plugin reload", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    test.vendor.deleteBeforeFailure = true;
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("metadata removal"),
    });
    expect(
      await test.bb.storage.kv.get(
        (await test.bb.storage.kv.list("allocations/"))[0]!,
      ),
    ).toMatchObject({ phase: "deleting" });
    test.vendor.deleteBeforeFailure = false;
    test.vendor.deleteFailure = true;
    const reloaded = await test.harness.lifecycle.reload(
      createVercelSandboxPlugin(test.vendor.transport),
    );
    const machine =
      reloaded.harness.registrations.machineProviders.get("vercel-sandbox")!;
    expect(await machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(
      test.vendor.requests.filter((request) =>
        request.url.pathname.endsWith("/stop"),
      ),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    "recovers named create collision only when ownership matches (foreign=%s)",
    async (foreign) => {
      const test = await setup();
      test.vendor.onCreate = async () => {
        test.vendor.onCreate = null;
        const request = test.vendor.requests.at(-1)!;
        await test.vendor.transport(request.url, {
          method: "POST",
          body: JSON.stringify(request.body),
        });
        if (foreign)
          test.vendor.allocations.values().next().value!.sandbox.tags.bbOwner =
            "foreign-server";
      };
      expect(await test.machine.create(test.context)).toMatchObject({
        status: foreign ? "failed" : "created",
      });
      expect(test.bootstraps).toBe(foreign ? 0 : 1);
      expect(test.vendor.allocationCount).toBe(1);
      expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
        status: foreign ? "failed" : "removed",
      });
      if (foreign) expect(test.vendor.deleteCount).toBe(0);
    },
  );

  it("persists allocation intent and checkpoints compute before an enrollment failure, then removes compute", async () => {
    const test = await setup({
      async bootstrap() {
        expect(resourceSchema.parse(test.stored).sessionId).toBe("session-1");
        throw new Error("secret-token enrollment denied");
      },
    });
    test.vendor.onCreate = async () => {
      const keys = await test.bb.storage.kv.list("allocations/");
      expect(await test.bb.storage.kv.get(keys[0]!)).toMatchObject({
        phase: "submitted",
      });
    };
    const result = await test.machine.create(test.context);
    expect(result).toMatchObject({ status: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(test.bootstraps).toBe(1);
    expect(test.vendor.allocationCount).toBe(1);
    expect(
      await test.machine.remove({
        hostId: "host_vercel",
        resource: test.stored!,
        signal: test.context.signal,
        report,
      }),
    ).toEqual({ status: "removed" });
    expect(test.vendor.allocations.size).toBe(0);
    for (const key of await test.bb.storage.kv.list())
      expect(JSON.stringify(await test.bb.storage.kv.get(key))).not.toContain(
        "secret-token",
      );
  });

  it("recovers a checkpoint failure by durable key without bootstrap or duplicate compute", async () => {
    const test = await setup();
    expect(
      await test.machine.create({
        ...test.context,
        async checkpoint() {
          throw new Error("checkpoint unavailable");
        },
      }),
    ).toMatchObject({ status: "failed" });
    expect(test.bootstraps).toBe(0);
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(test.vendor.deleteCount).toBe(1);
    expect(test.vendor.allocationCount).toBe(1);
  });

  it.each(["network-after", "abort-after", 500, 503] as const)(
    "recovers acceptance with lost response (%s) without retrying the mutation",
    async (failure) => {
      const test = await setup();
      test.vendor.failure = failure;
      expect(await test.machine.create(test.context)).toMatchObject({
        status: "created",
      });
      expect(
        await test.machine.create({ ...test.context, attempt: 2 }),
      ).toMatchObject({ status: "created" });
      expect(
        test.vendor.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
      expect(test.vendor.allocationCount).toBe(1);
      expect(resourceSchema.parse(test.stored).expiresAt).toBe(
        200 + 30 * 60_000,
      );
      test.vendor.deleteFailure = true;
      expect(await test.machine.reconcileCleanup(test.context)).toEqual({
        status: "removed",
      });
      expect(test.vendor.deleteCount).toBe(1);
    },
  );

  it.each(["network-before", 400, 429] as const)(
    "keeps uncertain absence (%s) pending until an owned allocation is visible",
    async (failure) => {
      const test = await setup();
      test.vendor.failure = failure;
      expect(await test.machine.create(test.context)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("unresolved"),
      });
      expect(
        await test.machine.create({ ...test.context, attempt: 2 }),
      ).toMatchObject({ status: "failed" });
      expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
        status: "failed",
        message: expect.stringContaining("unresolved"),
      });
      expect(
        test.vendor.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
      expect(test.bootstraps).toBe(0);
      const submitted = test.vendor.requests.find(
        (request) => request.method === "POST",
      )!;
      test.vendor.failure = null;
      await test.vendor.transport(submitted.url, {
        method: "POST",
        body: JSON.stringify(submitted.body),
      });
      expect(await test.machine.reconcileCleanup(test.context)).toEqual({
        status: "removed",
      });
      expect(test.vendor.allocations.size).toBe(0);
    },
  );

  it("allows a deliberate launch with the same core key only after confirmed cleanup", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const original = resourceSchema.parse(test.stored);
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(await test.machine.create(test.context)).toMatchObject({
      status: "created",
    });
    expect(test.vendor.allocationCount).toBe(2);
    expect(resourceSchema.parse(test.stored).sessionId).not.toBe(
      original.sessionId,
    );
    expect(
      await test.machine.remove({
        ...test.context,
        hostId: "old-host",
        resource: original,
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("session changed"),
    });
    expect(test.vendor.allocations.size).toBe(1);
  });

  it.each([401, 403, 404, 422])(
    "retains submission intent after create rejection %s when absence is unconfirmed",
    async (status) => {
      const test = await setup();
      test.vendor.failure = status;
      const result = await test.machine.create(test.context);
      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringContaining("unresolved"),
      });
      expect(JSON.stringify(result)).not.toContain("secret-token");
      expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
        status: "failed",
      });
      expect(test.vendor.allocations.size).toBe(0);
      expect(
        await test.bb.storage.kv.get(
          (await test.bb.storage.kv.list("allocations/"))[0]!,
        ),
      ).toMatchObject({ phase: "stopping" });
    },
  );

  it.each(["stopped", "missing"])(
    "refuses to replace %s compute or run bootstrap on replay",
    async (state) => {
      const test = await setup();
      await test.machine.create(test.context);
      const name = resourceSchema.parse(test.stored).sandboxName;
      if (state === "missing") test.vendor.allocations.delete(name);
      else {
        const allocation = test.vendor.allocations.get(name)!;
        allocation.session.status = "stopped";
        allocation.sandbox.status = "stopped";
      }
      expect(
        await test.machine.create({ ...test.context, attempt: 2 }),
      ).toMatchObject({ status: "failed" });
      expect(test.bootstraps).toBe(1);
      expect(test.vendor.allocationCount).toBe(1);
      expect(
        test.vendor.requests
          .filter(
            (request) =>
              request.method === "GET" && request.url.pathname.endsWith(name),
          )
          .every(
            (request) => request.url.searchParams.get("resume") === "false",
          ),
      ).toBe(true);
      expect(await test.machine.reconcileCleanup(test.context)).toEqual({
        status: "removed",
      });
    },
  );

  it("reuses its persisted server namespace across plugin reload and keeps original resource defaults", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const before = test.stored;
    await test.harness.behavior.setSettings({
      defaultVcpus: 4,
      defaultTimeoutMinutes: 40,
    });
    const replacement = await test.harness.lifecycle.reload(
      createVercelSandboxPlugin(test.vendor.transport),
    );
    const reloaded =
      replacement.harness.registrations.machineProviders.get("vercel-sandbox")!;
    expect(
      await reloaded.create({ ...test.context, attempt: 2 }),
    ).toMatchObject({ status: "created", resource: before });
    expect(test.vendor.allocationCount).toBe(1);
  });

  it("refuses changed account scope, foreign owner tags, and changed session identities before deletion", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const resource = resourceSchema.parse(test.stored);
    const before = test.vendor.requests.length;
    await test.harness.behavior.setSettings({ projectId: "prj_other" });
    expect(
      await test.machine.remove({
        ...test.context,
        hostId: "host_vercel",
        resource,
      }),
    ).toMatchObject({
      status: "failed",
      message: expect.stringContaining("original"),
    });
    expect(test.vendor.requests).toHaveLength(before);
    await test.harness.behavior.setSettings({ projectId: "prj_test" });
    const allocation = test.vendor.allocations.get(resource.sandboxName)!;
    allocation.sandbox.tags.bbOwner = "foreign-server";
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("ownership"),
    });
    allocation.sandbox.tags.bbOwner = resource.owner;
    allocation.session.id = "session-foreign";
    expect(await test.machine.reconcileCleanup(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("session changed"),
    });
    expect(test.vendor.deleteCount).toBe(0);
  });

  it("observes cancellation after allocation while leaving compute reachable for cleanup", async () => {
    const test = await setup();
    const abort = new AbortController();
    await expect(
      test.machine.create({
        ...test.context,
        signal: abort.signal,
        async checkpoint(resource) {
          await test.context.checkpoint(resource);
          abort.abort();
        },
      }),
    ).rejects.toThrow();
    expect(test.bootstraps).toBe(0);
    expect(await test.machine.reconcileCleanup(test.context)).toEqual({
      status: "removed",
    });
    expect(test.vendor.allocations.size).toBe(0);
  });
});

describe("diagnostics and launch validation", () => {
  it("requires direct owned-session proof and refuses foreign session data or stale allocation generations", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const resource = resourceSchema.parse(test.stored);
    const allocation = test.vendor.allocations.get(resource.sandboxName)!;
    allocation.sandbox.status = "stopped";
    const inspect = () =>
      test.harness.behavior.callRpc("machine.inspect", {
        hostId: "host_vercel",
      });
    expect(await inspect()).toMatchObject({
      values: { state: "running", computeEnded: false },
    });
    allocation.session.status = "stopped";
    expect(await inspect()).toMatchObject({
      values: { state: "stopped", computeEnded: true },
    });
    test.vendor.hiddenSessions.add(resource.sessionId!);
    expect(await inspect()).toMatchObject({
      values: {
        state: "missing",
        computeEnded: false,
        sessionId: resource.sessionId,
        expiresAt: resource.expiresAt,
      },
    });
    test.vendor.hiddenSessions.clear();
    test.vendor.sessionScopeMismatch = true;
    await expect(inspect()).rejects.toThrow("ownership does not match");
    test.vendor.sessionScopeMismatch = false;
    await test.machine.reconcileCleanup(test.context);
    await test.machine.create(test.context);
    test.stored = resource;
    const before = test.vendor.requests.length;
    await expect(inspect()).rejects.toThrow("session changed");
    expect(test.vendor.requests).toHaveLength(before);
  });
  it("validates CPU defaults and emits the allowed launch CPU choices through RPC/CLI without credentials", async () => {
    const test = await setup();
    const choices = [
      1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32,
    ];
    expect(
      await test.harness.behavior.callRpc("launch.options", {}),
    ).toMatchObject({ limits: { allowedVcpus: choices } });
    await test.harness.behavior.setSettings({ defaultVcpus: 3 });
    await expect(
      test.harness.behavior.callRpc("launch.options", {}),
    ).rejects.toThrow("1 or an even count");
    expect(await test.machine.validate!({ inputs: null })).toMatchObject({
      action: "refuse",
    });
    expect(await test.machine.create(test.context)).toMatchObject({
      status: "failed",
    });
    expect(test.vendor.requests).toHaveLength(0);
    await test.harness.behavior.setSettings({ defaultVcpus: 1 });
    expect(await test.machine.create(test.context)).toMatchObject({
      status: "created",
    });
    expect(
      test.vendor.requests.find((request) => request.method === "POST")?.body,
    ).toMatchObject({ resources: { vcpus: 1 } });
  });

  it("refuses OIDC credentials before SDK scope override or implicit local token refresh", async () => {
    const test = await setup();
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ owner_id: "team_foreign", project_id: "prj_foreign" })).toString("base64url")}.secret`;
    await test.harness.behavior.setSettings({ token });
    expect(await test.machine.create(test.context)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("access token"),
    });
    const result = await test.harness.behavior.callRpc("account.inspect", {});
    expect(result).toMatchObject({ available: false });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(test.vendor.requests).toHaveLength(0);
  });
  it("keeps read retries and CLI/RPC parity without allocating or returning credentials", async () => {
    const test = await setup();
    test.vendor.readFailures = 1;
    const rpc = await test.harness.behavior.callRpc("account.inspect", {});
    expect(rpc).toMatchObject({
      available: true,
      message: expect.stringContaining("Create permission"),
    });
    const cli = await test.harness.behavior.runCli([
      "account",
      "inspect",
      "--json",
    ]);
    expect(JSON.parse(cli.stdout)).toEqual(rpc);
    expect(
      test.vendor.requests.every((request) => request.method === "GET"),
    ).toBe(true);
    expect(test.vendor.requests).toHaveLength(3);
    expect(
      JSON.stringify(await test.harness.behavior.callRpc("launch.options", {})),
    ).not.toContain(settings.token);
    test.vendor.listFailure = true;
    const failed = await test.harness.behavior.callRpc("account.inspect", {});
    expect(failed).toMatchObject({ available: false });
    expect(JSON.stringify(failed)).not.toContain(settings.token);
  });

  it("inspects vendor expiry and refuses resources belonging to another provider", async () => {
    const test = await setup();
    await test.machine.create(test.context);
    const result = await test.harness.behavior.callRpc("machine.inspect", {
      hostId: "host_vercel",
    });
    expect(result).toMatchObject({
      values: { state: "running", expiresAt: 1_800_200, memoryMiB: 4096 },
    });
    test.harness.sdk.stub("hosts.get", () =>
      makeHostResponse({ machineProviderId: "foreign" }),
    );
    const before = test.vendor.requests.length;
    await expect(
      test.harness.behavior.callRpc("machine.inspect", {
        hostId: "host_foreign",
      }),
    ).rejects.toThrow("not owned");
    expect(test.vendor.requests).toHaveLength(before);
  });

  it.each([
    { vcpus: 0 },
    { vcpus: 33 },
    { vcpus: 3 },
    { vcpus: 31 },
    { vcpus: 1.5 },
    { timeoutMinutes: 4 },
    { timeoutMinutes: 1441 },
    { timeoutMinutes: 5.5 },
    { token: "secret-token" },
  ])("rejects invalid or credential-bearing launch input %j", (input) => {
    expect(launchInputsSchema.safeParse(input).success).toBe(false);
  });
});
