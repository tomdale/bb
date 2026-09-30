// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));

const LAUNCH_OPTIONS = {
  image: "vercel/sandbox/universal:latest",
  defaultInputs: { vcpus: 2, timeoutMinutes: 30 },
  limits: {
    minVcpus: 1,
    maxVcpus: 32,
    allowedVcpus: [
      1,
      ...Array.from({ length: 16 }, (_, index) => (index + 1) * 2),
    ],
    minTimeoutMinutes: 5,
    maxTimeoutMinutes: 1440,
  },
  memoryMiBPerVcpu: 2048,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function mockViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  mockViewport(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function inputsSlot() {
  const registration = app.machineProviderInputs.find(
    (candidate) => candidate.machineProviderId === PROVIDER_ID,
  );
  if (registration === undefined) throw new Error("inputs not registered");
  return registration;
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("registrations", () => {
  it("registers only the launch control, settings section, and expiry indicator", () => {
    expect(
      app.machineProviderInputs.map((slot) => slot.machineProviderId),
    ).toEqual([PROVIDER_ID]);
    expect(app.settingsSections.map((slot) => slot.id)).toEqual(["sandbox"]);
    expect(app.threadHeaderActions.map((slot) => slot.id)).toEqual(["expiry"]);
    expect(app.navPanels).toEqual([]);
  });
});

describe("launch inputs control", () => {
  it("submits defaults immediately and shows the effective launch", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    expect(onChange).toHaveBeenCalledWith({ status: "ready", value: {} });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 2 vCPU, stops after 30 minutes",
    });
    expect(trigger.textContent).toContain("2 vCPU · 30 min");
    expect(trigger.textContent).toContain("2 · 30m");
    expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: {} });
  });

  it("states the data-loss and plan boundaries where the choice is made", async () => {
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange: vi.fn() },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /2 vCPU/ }));
    await slot.findByText(/stops for good at its time limit/);
    expect(
      slot.getByText(/BB can't extend, pause, or restore it/),
    ).toBeTruthy();
    expect(slot.getByText(/Choices are Vercel maximums/)).toBeTruthy();
    const eight = slot.getByRole("menuitemradio", { name: /8 vCPU · 16 GiB/ });
    expect(eight.textContent).toContain("Pro+");
    const thirtyTwo = slot.getByRole("menuitemradio", {
      name: /32 vCPU · 64 GiB/,
    });
    expect(thirtyTwo.textContent).toContain("Enterprise");
    expect(
      slot
        .getByRole("menuitemradio", { name: /2 vCPU · 4 GiB \(default\)/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      slot.getByRole("menuitemradio", { name: /^24 h/ }).textContent,
    ).toContain("Pro+");
    expect(
      slot.getByRole("menuitemradio", { name: /^45 min/ }).textContent,
    ).not.toContain("Pro+");
  });

  it("emits a complete explicit selection after a pick", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /2 vCPU/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /8 vCPU · 16 GiB/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 8, timeoutMinutes: 30 },
    });
  });

  it("keeps a seeded choice and lists it even off the ladder", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 6, timeoutMinutes: 90 }, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 6 vCPU, stops after 1 hour 30 minutes",
    });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 6, timeoutMinutes: 90 },
    });
    openMenu(trigger);
    expect(
      (
        await slot.findByRole("menuitemradio", { name: /6 vCPU · 12 GiB/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      slot
        .getByRole("menuitemradio", { name: /1 h 30 min/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("blocks a stale out-of-range selection until a new choice is made", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 8 }, onChange },
      {
        rpc: {
          "launch.options": () => ({
            ...LAUNCH_OPTIONS,
            limits: {
              ...LAUNCH_OPTIONS.limits,
              maxVcpus: 4,
              allowedVcpus: [1, 2, 4],
            },
          }),
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: choose new options",
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        status: "blocked",
        reason: expect.stringContaining(
          "8 vCPU isn't available. Vercel allows 1, 2, 4 vCPUs",
        ),
      });
    });
    openMenu(trigger);
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /4 vCPU · 8 GiB/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 4, timeoutMinutes: 30 },
    });
  });

  it("blocks a seeded odd vCPU count above one that Vercel rejects", () => {
    const onChange = vi.fn();
    renderSlot(
      inputsSlot(),
      { value: { vcpus: 3, timeoutMinutes: 30 }, onChange },
      { rpc: { "launch.options": () => new Promise(() => {}) } },
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "blocked",
      reason: expect.stringContaining("Vercel accepts 1 or an even number"),
    });
  });

  it.each([
    ["condenses the full allowed list", null, [1, 2, 4, 8, 16, 32]],
    ["keeps a valid current choice", { vcpus: 6 }, [1, 2, 4, 6, 8, 16, 32]],
  ])("%s to valid vCPU counts", async (_label, value, expected) => {
    const slot = renderSlot(
      inputsSlot(),
      { value, onChange: vi.fn() },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /vCPU/ }));
    const counts = (await slot.findAllByRole("menuitemradio"))
      .map((item) => /^(\d+) vCPU/.exec(item.textContent ?? "")?.[1])
      .filter((count): count is string => count !== undefined)
      .map(Number);
    expect(counts).toEqual(expected);
  });

  it.each([
    ["an unknown key", { preset: "Large" }],
    ["a fractional vCPU count", { vcpus: 1.5 }],
    ["a non-object value", "Large"],
  ])("blocks %s without waiting for options", (_label, value) => {
    const onChange = vi.fn();
    renderSlot(
      inputsSlot(),
      { value, onChange },
      { rpc: { "launch.options": () => new Promise(() => {}) } },
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "blocked",
      reason: expect.stringContaining("invalid"),
    });
  });

  it("stays submittable when options fail and recovers on retry", async () => {
    const onChange = vi.fn();
    let calls = 0;
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      {
        rpc: {
          "launch.options": () => {
            calls += 1;
            if (calls === 1)
              throw new Error("vendor said: token abc123 rejected");
            return LAUNCH_OPTIONS;
          },
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: options unavailable",
    });
    expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: {} });
    openMenu(trigger);
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Couldn't load Vercel launch options",
    );
    expect(slot.queryByText(/abc123/)).toBeNull();
    expect(slot.getByText(/stops for good/)).toBeTruthy();
    fireEvent.click(slot.getByRole("menuitem", { name: "Retry" }));
    await slot.findByRole("menuitemradio", { name: /2 vCPU · 4 GiB/ });
    expect(calls).toBe(2);
  });

  it("ignores a launch options response that lands after unmount", async () => {
    const pending = deferred<typeof LAUNCH_OPTIONS>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange: vi.fn() },
      { rpc: { "launch.options": () => pending.promise } },
    );
    slot.lifecycle.unmount();
    await act(async () => {
      pending.resolve(LAUNCH_OPTIONS);
      await pending.promise;
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("opens the same choices and warning in the compact drawer", async () => {
    mockViewport(true);
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    fireEvent.click(await slot.findByRole("button", { name: /2 vCPU/ }));
    await slot.findByText(/stops for good at its time limit/);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /^1 h/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 2, timeoutMinutes: 60 },
    });
  });
});

describe("settings section", () => {
  function settingsSlot() {
    const section = app.settingsSections[0];
    if (section === undefined) throw new Error("settings not registered");
    return section;
  }

  it("reports a reachable scope without claiming launch entitlement", async () => {
    const slot = renderSlot(
      settingsSlot(),
      {},
      {
        rpc: {
          "account.inspect": () => ({
            available: true,
            message: "Authenticated",
            teamId: "team_abc",
            projectId: "prj_def",
          }),
          "launch.options": () => LAUNCH_OPTIONS,
        },
      },
    );
    await slot.findByText(
      /The token can list sandboxes in team_abc \/ prj_def/,
    );
    expect(
      slot.getByText(/doesn't confirm your plan's sandbox limits/),
    ).toBeTruthy();
    expect(slot.getByText("2 vCPU · 4 GiB")).toBeTruthy();
    expect(slot.getByText("30 min")).toBeTruthy();
    expect(slot.getByText("1–32 vCPU, 5 min–24 h")).toBeTruthy();
    expect(slot.getByText("vercel/sandbox/universal:latest")).toBeTruthy();
    expect(slot.getByText(/stops for good at its time limit/)).toBeTruthy();
    expect(
      slot.getByText(/Vercel bills your team while a sandbox runs/),
    ).toBeTruthy();
  });

  it("shows a pending check, the backend's unavailable message, and re-checks", async () => {
    const first = deferred<{
      available: boolean;
      message: string;
      teamId: string | null;
      projectId: string | null;
    }>();
    let calls = 0;
    const slot = renderSlot(
      settingsSlot(),
      {},
      {
        rpc: {
          "account.inspect": () => {
            calls += 1;
            return calls === 1
              ? first.promise
              : {
                  available: true,
                  message: "ok",
                  teamId: "team_a",
                  projectId: "prj_b",
                };
          },
          "launch.options": () => LAUNCH_OPTIONS,
        },
      },
    );
    expect(slot.getByText("Checking the Vercel connection…")).toBeTruthy();
    const button = slot.getByRole("button", { name: "Check again" });
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      first.resolve({
        available: false,
        message: "Set a valid Vercel access token in the plugin settings.",
        teamId: null,
        projectId: null,
      });
      await first.promise;
    });
    expect(
      slot.getByText("Set a valid Vercel access token in the plugin settings."),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Check again" }));
    await slot.findByText(/The token can list sandboxes in team_a \/ prj_b/);
    expect(calls).toBe(2);
  });

  it("replaces RPC failures with generic copy", async () => {
    const slot = renderSlot(
      settingsSlot(),
      {},
      {
        rpc: {
          "account.inspect": () => {
            throw new Error("raw vendor body with token xyz");
          },
          "launch.options": () => {
            throw new Error("raw");
          },
        },
      },
    );
    await slot.findByText(/Couldn't check the Vercel connection/);
    await slot.findByText("Couldn't load launch defaults.");
    expect(slot.queryByText(/xyz/)).toBeNull();
  });
});

describe("expiry indicator", () => {
  function headerSlot() {
    const action = app.threadHeaderActions[0];
    if (action === undefined) throw new Error("header action not registered");
    return action;
  }

  function sdkFor(machineProviderId: string | null, phase = "active") {
    return {
      threads: {
        get: () => ({ id: "thread-1", environmentId: "env-1" }),
      },
      environments: { get: () => ({ id: "env-1", hostId: "host-1" }) },
      hosts: {
        get: () => ({
          id: "host-1",
          machineProviderId,
          lifecycle: { phase },
        }),
      },
    };
  }

  function machine(overrides: Record<string, unknown>, summary = "running") {
    return {
      summary,
      values: {
        state: "running",
        sandboxName: "bb-host-1",
        sessionId: "sbx_1",
        expiresAt: null,
        vcpus: 2,
        memoryMiB: 4096,
        image: LAUNCH_OPTIONS.image,
        teamId: "team_a",
        projectId: "prj_b",
        ...overrides,
      },
    };
  }

  const props = {
    threadId: "thread-1",
    projectId: "project-1",
    isCompactViewport: false,
  };

  it("renders nothing for threads on other machines", async () => {
    const inspect = vi.fn();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(null) as never,
      rpc: { "machine.inspect": inspect },
    });
    await waitFor(() => {
      expect(slot.inspection.sdkCalls.map((call) => call.method)).toContain(
        "hosts.get",
      );
    });
    expect(slot.container.textContent).toBe("");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("renders nothing while the thread has no environment", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: {
        threads: { get: () => ({ id: "thread-1", environmentId: null }) },
      } as never,
    });
    await waitFor(() => {
      expect(slot.inspection.sdkCalls.map((call) => call.method)).toEqual([
        "threads.get",
      ]);
    });
    expect(slot.container.textContent).toBe("");
  });

  it("counts down and warns inside the last ten minutes", async () => {
    const now = Date.now();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () =>
          machine({ expiresAt: now + 25 * 60_000 + 5_000 }),
      },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 25 minutes left",
    });
    expect(trigger.textContent).toBe("25m left");
    expect(trigger.className).not.toContain("text-warning-text");
    openMenu(trigger);
    await slot.findByText(/Stops at .*BB can't extend, pause, or save it/);
    expect(slot.getByText("2 vCPU · 4 GiB")).toBeTruthy();
  });

  it("uses warning tone near expiry and an icon-only compact trigger", async () => {
    const slot = renderSlot(
      headerSlot(),
      { ...props, isCompactViewport: true },
      {
        sdk: sdkFor(PROVIDER_ID) as never,
        rpc: {
          "machine.inspect": () =>
            machine({ expiresAt: Date.now() + 4 * 60_000 + 5_000 }),
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 4 minutes left",
    });
    expect(trigger.textContent).toBe("");
    expect(trigger.className).toContain("text-warning-text");
  });

  it("reports an ended session only after a second read and keeps Refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inspect = vi.fn(() => machine({ state: "stopped" }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: confirming whether it stopped",
    });
    expect(slot.queryByText(/files are gone/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: stopped",
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    openMenu(trigger);
    await slot.findByText(/session has ended\. BB keeps no snapshot/);
    expect(slot.queryByText(/files are gone/)).toBeNull();
    expect(slot.getByRole("menuitem", { name: "Refresh" })).toBeTruthy();
  });

  it("never treats repeated missing reads as a confirmed stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inspect = vi.fn(() =>
      machine(
        { state: "missing", expiresAt: Date.now() + 60 * 60_000 },
        "Compute termination unresolved; retry cleanup after checking the Vercel dashboard.",
      ),
    );
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: status unknown",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    openMenu(trigger);
    await slot.findByText(/It may still be running/);
    expect(slot.getByText(/Compute termination unresolved/)).toBeTruthy();
    fireEvent.click(slot.getByRole("menuitem", { name: "Refresh" }));
    await waitFor(() => {
      expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    expect(
      slot.getByRole("button", {
        name: "Vercel sandbox: status unknown",
        hidden: true,
      }),
    ).toBeTruthy();
    expect(slot.queryByText(/files are gone|session has ended/)).toBeNull();
  });

  it("observes Vercel at the deadline instead of inferring a stop from the clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 2_000;
    const inspect = vi.fn(() => machine({ expiresAt }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: less than a minute left",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: time limit reached, awaiting Vercel status",
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    openMenu(trigger);
    await slot.findByText(/Waiting for Vercel to report/);
    expect(slot.queryByText(/stopped|files are gone/i)).toBeNull();
    expect(slot.getByRole("menuitem", { name: "Refresh" })).toBeTruthy();
  });

  it("recovers when a stale stopped read is followed by a running one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 2 * 60 * 60_000 + 30_000;
    const inspect = vi
      .fn()
      .mockReturnValueOnce(machine({ state: "stopped" }))
      .mockReturnValue(machine({ expiresAt }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: confirming whether it stopped",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await slot.findByRole("button", { name: "Vercel sandbox: 2 hours left" });
  });

  it("reports removal in progress without claiming it finished", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "removing") as never,
      rpc: { "machine.inspect": vi.fn() },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: being removed",
    });
    openMenu(trigger);
    await slot.findByText(/BB is removing this sandbox machine/);
    expect(slot.queryByText(/files are gone/)).toBeNull();
  });

  it("marks a destroyed machine as removed with no recovery action", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "destroyed") as never,
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: removed",
    });
    openMenu(trigger);
    await slot.findByText(/BB removed this sandbox machine/);
    expect(slot.queryByRole("menuitem")).toBeNull();
  });

  it("shows starting without inspecting a machine that is still being created", async () => {
    const inspect = vi.fn();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "creating") as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", { name: "Vercel sandbox: starting" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("recovers from an inspection failure with Retry", async () => {
    let calls = 0;
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () => {
          calls += 1;
          if (calls === 1) throw new Error("raw vendor detail");
          return machine({ expiresAt: Date.now() + 3 * 60 * 60_000 + 5_000 });
        },
      },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: status unavailable",
    });
    expect(slot.queryByText(/raw vendor detail/)).toBeNull();
    openMenu(trigger);
    await slot.findByText(/Stops at .*BB can't extend/);
    expect(
      slot.getByRole("button", {
        name: "Vercel sandbox: 3 hours left",
        hidden: true,
      }),
    ).toBeTruthy();
    expect(calls).toBe(2);
  });
});
