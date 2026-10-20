// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "@bb/client-core";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { SPLIT_LAYOUT_STORAGE_KEY } from "@/lib/split-layout/persistence";
import {
  resetPluginThreadRowStatusesForTest,
  setPluginThreadRowStatus,
} from "@/lib/plugin-thread-row-status";
import { TopLevelSidebarSection } from "./TopLevelSidebarSection";
import { SidebarControlButton } from "./SidebarRowControls";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetPluginThreadRowStatusesForTest();
  window.localStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
  window.sessionStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
});

describe("SidebarControlButton", () => {
  it("drops pointer focus before a section action opens a picker", () => {
    let triggerWasFocused = true;
    render(
      <TooltipProvider>
        <SidebarControlButton
          label="New thread"
          icon="MessageSquarePlus"
          onClick={() => {
            triggerWasFocused =
              document.activeElement ===
              screen.getByRole("button", { name: "New thread" });
          }}
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "New thread" });
    trigger.focus();

    fireEvent.click(trigger, { detail: 1 });

    expect(triggerWasFocused).toBe(false);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("retains section-action focus for keyboard activation", () => {
    render(
      <TooltipProvider>
        <SidebarControlButton
          label="New thread"
          icon="MessageSquarePlus"
          onClick={vi.fn()}
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByRole("button", { name: "New thread" });
    trigger.focus();

    fireEvent.click(trigger, { detail: 0 });

    expect(document.activeElement).toBe(trigger);
  });
});

describe("TopLevelSidebarSection", () => {
  it("exposes stable identity only for persisted sections", () => {
    const result = render(
      <>
        <TopLevelSidebarSection
          label="Design"
          sectionId="sec_design"
          collapseControl={{ isCollapsed: false, onToggleCollapsed: vi.fn() }}
        >
          <div>Design thread</div>
        </TopLevelSidebarSection>
        <TopLevelSidebarSection
          label="Pinned"
          collapseControl={{ isCollapsed: false, onToggleCollapsed: vi.fn() }}
        >
          <div>Pinned thread</div>
        </TopLevelSidebarSection>
      </>,
    );

    expect(
      result.container.querySelector('[data-sidebar-section-id="sec_design"]'),
    ).not.toBeNull();
    expect(
      screen
        .getByTitle("Pinned")
        .closest("[data-sidebar-sticky-group]")
        ?.hasAttribute("data-sidebar-section-id"),
    ).toBe(false);
  });

  it("keeps custom-section disclosure and count visible with an inset body", () => {
    const onToggleCollapsed = vi.fn();
    const result = render(
      <TopLevelSidebarSection
        label="Agent work"
        sectionId="sec_agent"
        threadCount={3}
        collapseControl={{ isCollapsed: false, onToggleCollapsed }}
      >
        <div>Parent and child threads</div>
      </TopLevelSidebarSection>,
    );
    const disclosure = screen.getByRole("button", {
      name: "Collapse Agent work section",
    });
    expect(disclosure.className).not.toContain("bb-sidebar-hover-actions");
    expect(
      disclosure.compareDocumentPosition(screen.getByTitle("Agent work")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("3 threads").textContent).toBe("3");
    expect(
      screen.getByText("Parent and child threads").parentElement?.className,
    ).toBe("pl-8");
    expect(
      screen.getByTitle("Agent work").closest('[data-sidebar="group-label"]')
        ?.className,
    ).toContain("font-semibold");
    fireEvent.click(disclosure);
    expect(onToggleCollapsed).toHaveBeenCalledOnce();

    result.rerender(
      <TopLevelSidebarSection
        label="Agent work"
        sectionId="sec_agent"
        threadCount={3}
        collapseControl={{ isCollapsed: true, onToggleCollapsed }}
      >
        <div>Parent and child threads</div>
      </TopLevelSidebarSection>,
    );
    expect(screen.queryByText("Parent and child threads")).toBeNull();
    expect(screen.getByLabelText("3 threads")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Expand Agent work section" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps custom-section drop previews aligned when collapsed", () => {
    render(
      <TopLevelSidebarSection
        label="Empty group"
        sectionId="sec_empty"
        threadCount={0}
        childrenInset={false}
        showChildrenWhenCollapsed
        collapseControl={{ isCollapsed: true, onToggleCollapsed: vi.fn() }}
      >
        <div>Drop preview</div>
      </TopLevelSidebarSection>,
    );
    expect(screen.getByLabelText("0 threads")).not.toBeNull();
    expect(screen.getByText("Drop preview").parentElement?.className).toBe(
      "pl-8",
    );
  });

  it("hides the section body and exposes an expand action when collapsed", () => {
    render(
      <TopLevelSidebarSection
        label="Pinned"
        collapseControl={{ isCollapsed: true, onToggleCollapsed: vi.fn() }}
      >
        <div>Pinned thread</div>
      </TopLevelSidebarSection>,
    );

    expect(screen.queryByText("Pinned thread")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand Pinned section" }),
    ).not.toBeNull();
  });

  it("can expose a drop preview while the section is collapsed", () => {
    render(
      <TopLevelSidebarSection
        label="Pinned"
        showChildrenWhenCollapsed
        collapseControl={{ isCollapsed: true, onToggleCollapsed: vi.fn() }}
      >
        <div>Projected thread</div>
      </TopLevelSidebarSection>,
    );

    expect(screen.getByText("Projected thread")).not.toBeNull();
  });

  it("can keep projected children without reserving an inset", () => {
    render(
      <TopLevelSidebarSection
        label="Design"
        childrenInset={false}
        collapseControl={{ isCollapsed: false, onToggleCollapsed: vi.fn() }}
      >
        <div>Projected thread</div>
      </TopLevelSidebarSection>,
    );

    expect(screen.getByText("Projected thread").parentElement?.className).toBe(
      "",
    );
    const label = screen
      .getByTitle("Design")
      .closest<HTMLElement>('[data-sidebar="group-label"]');
    expect(label?.style.marginBottom).toBe("0px");
  });

  it("renders the disclosure after the section label without a leading icon", () => {
    const result = render(
      <TopLevelSidebarSection
        label="Pinned"
        collapseControl={{ isCollapsed: false, onToggleCollapsed: vi.fn() }}
      >
        <div>Pinned thread</div>
      </TopLevelSidebarSection>,
    );

    const disclosure = screen.getByRole("button", {
      name: "Collapse Pinned section",
    });
    const icon = result.container.querySelector('[data-icon="Pin"]');
    const label = screen.getByTitle("Pinned");

    expect(icon).toBeNull();
    expect(
      label.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps collapsed activity inside the trailing controls slot", () => {
    render(
      <TopLevelSidebarSection
        label="TODO"
        actions={
          <>
            <button type="button">Display</button>
            <button type="button">Actions</button>
            <button type="button">New thread</button>
          </>
        }
        actionsAlwaysVisible
        actionsMobileAlways
        collapsedActivity={{
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          working: true,
          runtimeWorking: true,
        }}
        collapseControl={{ isCollapsed: true, onToggleCollapsed: vi.fn() }}
      >
        <div>Active thread</div>
      </TopLevelSidebarSection>,
    );

    const indicator = screen.getByLabelText("Thread working");
    const activitySlot = indicator.closest(
      "[data-sidebar-collapsed-activity-edge]",
    );
    const trailingControls = activitySlot?.parentElement;

    expect(
      trailingControls?.hasAttribute("data-sidebar-trailing-controls"),
    ).toBe(true);
    expect(trailingControls?.className).toContain("relative");
    expect(activitySlot?.className).toContain("max-md:static");
    expect(screen.queryByText("Active thread")).toBeNull();
  });

  it("rolls a hidden split thread up to a collapsed top-level section", () => {
    const store = createStore();
    store.set(splitLayoutAtom, {
      focusedPaneId: "pane-thread",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-thread",
            content: {
              kind: "thread",
              projectId: "project-one",
              threadId: "thread-one",
            },
          },
          {
            type: "pane",
            paneId: "pane-compose",
            content: { kind: "new-thread" },
          },
        ],
      },
    });

    render(
      <Provider store={store}>
        <TopLevelSidebarSection
          label="Pinned"
          collapsedActivity={NO_COLLAPSED_CHILD_ACTIVITY}
          collapsedThreads={[{ id: "thread-one", projectId: "project-one" }]}
          collapseControl={{ isCollapsed: true, onToggleCollapsed: vi.fn() }}
        >
          <div>Pinned thread</div>
        </TopLevelSidebarSection>
      </Provider>,
    );

    expect(
      screen.getByRole("img", {
        name: "Pinned — contains a thread open in split",
      }),
    ).not.toBeNull();
    expect(screen.queryByText("Pinned thread")).toBeNull();
  });

  it("rolls up a hidden plugin status only while the section is collapsed", () => {
    const renderSection = (isCollapsed: boolean) => (
      <TopLevelSidebarSection
        label="Building"
        collapsedActivity={NO_COLLAPSED_CHILD_ACTIVITY}
        collapsedThreads={[{ id: "thread-one", projectId: "project-one" }]}
        collapseControl={{ isCollapsed, onToggleCollapsed: vi.fn() }}
      >
        <div>Draft thread</div>
      </TopLevelSidebarSection>
    );
    const result = render(renderSection(true));

    expect(screen.queryByLabelText("Plugin improving draft")).toBeNull();
    act(() => {
      setPluginThreadRowStatus("thread-one", "prompt-shaper", {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
        tone: "running",
      });
    });

    expect(screen.getByLabelText("Plugin improving draft")).not.toBeNull();
    expect(screen.queryByText("Draft thread")).toBeNull();

    result.rerender(renderSection(false));

    expect(screen.queryByLabelText("Plugin improving draft")).toBeNull();
    expect(screen.getByText("Draft thread")).not.toBeNull();
  });
});
