// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("does not reactivate an idle reader from iframe scroll notifications", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { useUserActive } = await import("./user-activity");
  function Probe() {
    return <p role="status">{useUserActive() ? "active" : "idle"}</p>;
  }
  const view = render(<Probe />);
  act(() =>
    document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true })),
  );
  expect(screen.getByRole("status").textContent).toBe("active");
  act(() => vi.advanceTimersByTime(15_001));
  expect(screen.getByRole("status").textContent).toBe("idle");
  const frame = document.createElement("iframe");
  view.container.append(frame);
  act(() => frame.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));
  expect(screen.getByRole("status").textContent).toBe("idle");
  act(() =>
    document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true })),
  );
  expect(screen.getByRole("status").textContent).toBe("active");
});
