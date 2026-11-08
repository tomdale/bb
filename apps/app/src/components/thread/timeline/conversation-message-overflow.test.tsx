// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  BottomAnchorContext,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body";
import {
  ConversationMessageOverflowToggle,
  useOverflowMeasurement,
} from "./conversation-message-overflow";
import { createInertScrollPositionKeeper } from "@/test/scroll-position-keeper";
import { TimelineWindowedItems } from "./TimelineWindowedItems";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function OverflowProbe({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const measurement = useOverflowMeasurement({
    axis: "vertical",
    elementRef: ref,
    enabled: true,
    measurementKey: name,
  });
  return <div ref={ref} data-testid={name} data-measurement={measurement} />;
}

function MeasurementList({ children }: { children: ReactNode }) {
  return (
    <TimelineWindowedItems
      estimateItemHeight={() => 60}
      gap={0}
      itemKeys={["content"]}
      measurements={new Map()}
      positionKeeper={null}
      pinnedToEnd={false}
      renderItem={() => children}
    />
  );
}

describe("useOverflowMeasurement", () => {
  it("collects initial geometry before publishing results and shares one resize observer", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    const constructorSpy = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          constructorSpy();
          observerCallback = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const publishedWhileReading: string[] = [];
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        publishedWhileReading.push(
          screen.getByTestId("first").dataset.measurement ?? "",
        );
        return this.dataset.expanded === "true" ? 80 : 20;
      });
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(20);
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(20);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(20);

    function GrowFirstContent() {
      useLayoutEffect(() => {
        screen.getByTestId("first").dataset.expanded = "true";
      }, []);
      return null;
    }
    render(
      <MeasurementList>
        <OverflowProbe name="first" />
        <OverflowProbe name="second" />
        <GrowFirstContent />
      </MeasurementList>,
    );

    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");
    expect(first.dataset.measurement).toBe("overflowing");
    expect(second.dataset.measurement).toBe("fits");
    expect(publishedWhileReading).toEqual(["unmeasured", "unmeasured"]);
    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    const entries = [first, second].map(
      (target) => ({ target }) as unknown as ResizeObserverEntry,
    );
    scrollHeight.mockReturnValue(20);
    act(() => {
      observerCallback?.(entries, {} as ResizeObserver);
    });

    expect(first.dataset.measurement).toBe("fits");
    expect(second.dataset.measurement).toBe("fits");
    expect(clientHeight).toHaveBeenCalled();
    expect(scrollWidth).toHaveBeenCalled();
    expect(clientWidth).toHaveBeenCalled();
  });
});

function setResizeObservationAvailable(available: boolean) {
  vi.stubGlobal(
    "ResizeObserver",
    available
      ? class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      : undefined,
  );
}

describe("overflow invalidation", () => {
  it.each([true, false])(
    "remeasures child-only content changes without observer delivery (available: %s)",
    (available) => {
      setResizeObservationAvailable(available);
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.dataset.expanded === "true" ? 80 : 20;
        },
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        20,
      );
      function ExpandingContent() {
        const [expanded, setExpanded] = useState(false);
        const ref = useRef<HTMLDivElement>(null);
        const measurement = useOverflowMeasurement({
          axis: "vertical",
          elementRef: ref,
          enabled: true,
          measurementKey: String(expanded),
        });
        return (
          <div
            ref={ref}
            data-testid="changing"
            data-expanded={expanded}
            data-measurement={measurement}
          >
            <button type="button" onClick={() => setExpanded(true)}>
              Expand
            </button>
          </div>
        );
      }
      render(
        <MeasurementList>
          <ExpandingContent />
        </MeasurementList>,
      );
      expect(screen.getByTestId("changing").dataset.measurement).toBe("fits");

      fireEvent.click(screen.getByRole("button", { name: "Expand" }));

      expect(screen.getByTestId("changing").dataset.measurement).toBe(
        "overflowing",
      );
    },
  );
});

describe("standalone overflow", () => {
  it.each([true, false])(
    "measures synchronously without a list batch (observer available: %s)",
    (available) => {
      setResizeObservationAvailable(available);
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        80,
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        20,
      );

      render(<OverflowProbe name="fallback" />);

      expect(screen.getByTestId("fallback").dataset.measurement).toBe(
        "overflowing",
      );
    },
  );
});

describe("ConversationMessageOverflowToggle", () => {
  function renderToggle({
    expanded,
    rowTop,
  }: {
    expanded: boolean;
    rowTop: number;
  }) {
    const scrollArea = document.createElement("div");
    vi.spyOn(scrollArea, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 50, 100, 500),
    );
    const holdContentPosition = vi.fn<
      BottomAnchorContextValue["holdContentPosition"]
    >(({ update }) => update());
    const onToggle = vi.fn();
    const bottomAnchor: BottomAnchorContextValue = {
      getScrollElement: () => scrollArea,
      isAtBottom: true,
      scrollToBottom: vi.fn(),
      scrollElementIntoView: vi.fn(),
      positionKeeper: createInertScrollPositionKeeper(),
      holdContentPosition,
    };
    render(
      <BottomAnchorContext.Provider value={bottomAnchor}>
        <div data-timeline-row-id="row" data-testid="row">
          <ConversationMessageOverflowToggle
            expanded={expanded}
            onToggle={onToggle}
          />
        </div>
      </BottomAnchorContext.Provider>,
    );
    const row = screen.getByTestId("row");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, rowTop, 100, 1_000),
    );
    fireEvent.click(screen.getByRole("button"));
    return { holdContentPosition, onToggle, row };
  }

  it("holds the row top when expanding, even if the top is offscreen", () => {
    const { holdContentPosition, onToggle, row } = renderToggle({
      expanded: false,
      rowTop: -200,
    });

    expect(holdContentPosition).toHaveBeenCalledWith(
      expect.objectContaining({ edge: "top", element: row }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("holds the row bottom when collapsing a row whose top is offscreen", () => {
    const { holdContentPosition } = renderToggle({
      expanded: true,
      rowTop: -200,
    });

    expect(holdContentPosition).toHaveBeenCalledWith(
      expect.objectContaining({ edge: "bottom" }),
    );
  });

  it("holds the row top when collapsing a row whose top is visible", () => {
    const { holdContentPosition } = renderToggle({
      expanded: true,
      rowTop: 80,
    });

    expect(holdContentPosition).toHaveBeenCalledWith(
      expect.objectContaining({ edge: "top" }),
    );
  });
});
